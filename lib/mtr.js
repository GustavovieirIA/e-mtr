// Cliente das APIs de MTR dos órgãos ambientais. Dois dialetos:
//
//   feam  — API antiga (/api).      Autentica com token + chave_feam.
//                                   Respostas trazem retornoCodigo (0 = sucesso).
//   sinir — API nova (/apiws/rest). Autentica com Bearer no Authorization.
//                                   Respostas trazem { erro, mensagem, objetoResposta }.
//
// Este módulo substitui os workflows n8n: a mesma sequência (gettoken → chamada
// → normalização da resposta) roda agora nas funções em /api.

const TIMEOUT_MS = 25000;

/** Erro de negócio ou de comunicação — a mensagem vai direto para a tela. */
export class MtrError extends Error {}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// Nunca lança por status != 2xx: as APIs de MTR devolvem erro de negócio no
// corpo, às vezes com 200, às vezes com 4xx. Quem chama decide o que é erro.
export async function apiFetch(url, { method = 'POST', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal });
  } catch (err) {
    const host = hostDe(url);
    throw new MtrError(
      err.name === 'AbortError'
        ? `A API (${host}) não respondeu em ${TIMEOUT_MS / 1000}s.`
        : `Não foi possível falar com a API (${host}): ${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }
  const texto = await res.text();
  try { return JSON.parse(texto); } catch { return texto; }
}

function hostDe(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Só https e só domínio do governo: o apiBase chega do navegador, e sem esse
// filtro a função viraria um proxy aberto para qualquer endereço (SSRF).
// Para atender outro estado, basta que a URL do órgão termine em .gov.br.
export function validarApiBase(apiBase) {
  const bruto = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!bruto) throw new MtrError('URL da API não informada — configure o acesso em ⚙ Configurações.');
  let u;
  try { u = new URL(bruto); } catch { throw new MtrError(`URL da API inválida: ${bruto}`); }
  if (u.protocol !== 'https:') throw new MtrError('A URL da API precisa usar https.');
  if (!u.hostname.endsWith('.gov.br')) {
    throw new MtrError(`URL da API não permitida: ${u.hostname} (só domínios .gov.br).`);
  }
  return bruto;
}

// ── Autenticação ─────────────────────────────────────────────────────────────

export async function getTokenFeam(apiBase, auth) {
  exigirCampos(auth, ['pessoaCodigo', 'pessoaCnpj', 'usuarioCpf', 'senha']);
  const r = await apiFetch(`${apiBase}/gettoken`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(auth),
  });
  if (!r || typeof r !== 'object') {
    throw new MtrError(`Resposta inesperada do /gettoken: ${String(r).slice(0, 200)}`);
  }
  if (r.retornoCodigo !== 0) {
    throw new MtrError(`Falha na autenticação: ${r.retorno || `código ${r.retornoCodigo}`}`);
  }
  return { token: r.token, chave: r.chave };
}

export function headersFeam({ token, chave }) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    chave_feam: chave,
  };
}

// O SINIR desligou o login por usuário e senha em 01/08/2026 (o /gettoken
// responde "Endpoint desativado"). Agora o usuário gera um Token de Integração
// no próprio MTR (Configurações > Gerar Token API WS) e a API troca esse token
// por um Token de Acesso em POST /token, com o de integração no Authorization.
// O login antigo continua aqui para quem ainda não migrou (INEA-RJ).
export async function getTokenSinir(apiBase, auth) {
  const integracao = String(auth?.tokenIntegracao || '').trim().replace(/^Bearer\s+/i, '');
  if (integracao) return tokenAcessoSinir(apiBase, integracao);

  exigirCampos(auth, ['cpfCnpj', 'unidade', 'senha']);
  const r = await apiFetch(`${apiBase}/gettoken`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ cpfCnpj: auth.cpfCnpj, senha: auth.senha, unidade: auth.unidade }),
  });
  const erro  = r?.erro === true || r?.erro === 'true';
  const token = r?.objetoResposta;
  if (erro || typeof token !== 'string' || !token) {
    const msg = r?.mensagem || resumo(r);
    throw new MtrError(`Falha na autenticação SINIR: ${msg}`
      + (/desativado/i.test(String(msg)) ? ' Depois cole o token em Configurações, no campo Token de Integração.' : ''));
  }
  return token;   // já vem no formato "Bearer XXXX"
}

async function tokenAcessoSinir(apiBase, integracao) {
  const r = await apiFetch(`${apiBase}/token`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${integracao}` },
  });
  const erro = r?.erro === true || r?.erro === 'true';
  // o token de acesso pode vir direto em objetoResposta ou dentro de um objeto
  const o = r?.objetoResposta ?? r;
  const bruto = typeof o === 'string' ? o
    : (o?.token || o?.tokenAcesso || o?.accessToken || o?.access_token || '');
  if (erro || typeof bruto !== 'string' || !bruto.trim()) {
    // nunca devolve o corpo: ele pode trazer o próprio token. Só a mensagem ou os nomes dos campos.
    const campos = o && typeof o === 'object' ? Object.keys(o).join(', ') : typeof o;
    throw new MtrError(`Falha na autenticação SINIR: ${r?.mensagem || `resposta sem token de acesso (campos: ${campos})`}`);
  }
  return /^Bearer\s/i.test(bruto) ? bruto.trim() : `Bearer ${bruto.trim()}`;
}

export function headersSinir(token) {
  return { 'Content-Type': 'application/json; charset=utf-8', Authorization: token };
}

function exigirCampos(auth, campos) {
  const faltando = campos.filter(c => !auth?.[c]);
  if (faltando.length) {
    throw new MtrError(`Credenciais incompletas (falta: ${faltando.join(', ')}) — confira ⚙ Configurações.`);
  }
}

// ── Requisição / resposta das funções ────────────────────────────────────────

export function corpoJSON(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  }
  return req.body || {};
}

/** emitir e baixa respondem texto puro; a tela detecta ❌ para marcar erro. */
export function respostaTexto(res, mensagem, status = 200) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(status).send(mensagem);
}

/** consulta responde JSON no formato que a tabela já consome. */
export function respostaJSON(res, obj, status = 200) {
  res.status(status).json(obj);
}

// ── Conversões ───────────────────────────────────────────────────────────────

export const soDigitos = v => (v == null ? '' : String(v).replace(/\D/g, ''));

/** CNPJ/CPF limpo, ou null quando vazio (formato esperado pela API antiga). */
export const documentoOuNulo = v => (v ? String(v).replace(/\D/g, '') : null);

// A API antiga aceita null onde o número não veio — é o que o JSON.stringify
// fazia com o NaN do parseInt no n8n. Mantido igual para não mudar o payload.
export const inteiroOuNulo = v => { const n = parseInt(v, 10);  return Number.isNaN(n) ? null : n; };
// Aceita decimal à brasileira: "0,24" e "1.234,56" valem 0.24 e 1234.56.
// Sem isso, parseFloat("0,24") pára na vírgula e vira 0 — e baixa com
// quantidade zero é rejeitada pelo órgão.
export function decimalBR(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(s);
}

export const decimalOuNulo = v => { const n = decimalBR(v);     return Number.isNaN(n) ? null : n; };

// A API nova rejeita null nos códigos — ali o padrão é 0.
export const inteiroOuZero  = v => { const n = parseInt(v, 10);  return Number.isNaN(n) ? 0 : n; };
export const decimalOuZero  = v => { const n = decimalBR(v);     return Number.isNaN(n) ? 0 : n; };

/** AAAAMMDD → epoch em ms (meio-dia UTC, para não escorregar de dia no fuso). */
export function dataParaEpoch(v) {
  const s = soDigitos(v);
  if (s.length === 8) return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12, 0, 0);
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

export const resumo = obj => {
  try { return JSON.stringify(obj).slice(0, 200); } catch { return String(obj).slice(0, 200); }
};

/** Roda fn sobre os itens em lotes, para não disparar dezenas de requisições de uma vez. */
export async function emLotes(itens, tamanho, fn) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    saida.push(...await Promise.all(itens.slice(i, i + tamanho).map(fn)));
  }
  return saida;
}

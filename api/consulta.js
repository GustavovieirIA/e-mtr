// POST /api/consulta — lista MTRs para dar baixa.
// Substitui os workflows "MTR-MG - 3. Consultar Pendentes" e "MTR-SINIR - 3. Consultar Pendentes".
//
// Os dois dialetos devolvem o MESMO formato ({ manifests: [...] }, campos estilo
// FEAM), para a mesma tabela da tela servir aos dois.
//
// Com `numeros` no corpo, a consulta é POR NÚMERO nos dois dialetos e devolve o
// MTR em qualquer situação (emitido, recebido, cancelado…), mais a lista dos que
// não vieram: é o que a Baixa c/ número usa para conferir antes de baixar.
import {
  MtrError, apiFetch, validarApiBase,
  getTokenFeam, headersFeam, getTokenSinir, headersSinir,
  corpoJSON, respostaJSON, soDigitos, emLotes,
} from '../lib/mtr.js';

// A consulta do FEAM faz uma requisição por manifesto do período; em lotes para
// não abrir dezenas de conexões simultâneas contra a API do órgão.
const LOTE = 6;
// Teto da busca por número: cabe folgado nos 60 s da função (6 por vez).
const MAX_NUMEROS = 60;
const SEM_RESPOSTA = Symbol('sem-resposta');

const SITUACOES = {
  1: 'Emitido (aguarda baixa)',
  3: 'Recebido',
  4: 'Cancelado',
  9: 'Armazenamento Temp.',
};

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return respostaJSON(res, vazio('❌ Método não permitido.'), 405);

  const form = corpoJSON(req);
  try {
    const apiBase = validarApiBase(form.apiBase);
    const resultado = form.dialect === 'sinir'
      ? await consultaSinir(apiBase, form)
      : await consultaFeam(apiBase, form);
    return respostaJSON(res, resultado);
  } catch (err) {
    if (err instanceof MtrError) return respostaJSON(res, vazio(`❌ ${err.message}`));
    return respostaJSON(res, vazio(`❌ Erro inesperado na consulta: ${err.message}`), 500);
  }
}

const vazio = mensagem => ({ sucesso: false, total: 0, totalPendentes: 0, manifests: [], mensagem });

// ── API antiga (FEAM-MG): lista por período ──────────────────────────────────

async function consultaFeam(apiBase, form) {
  if (Array.isArray(form.numeros)) return consultaFeamPorNumero(apiBase, form);

  const inicio = soDigitos(form.dataInicio);
  const fim    = soDigitos(form.dataFim);
  if (inicio.length !== 8 || fim.length !== 8) {
    return vazio('❌ Período inválido — informe Data Início e Data Fim.');
  }

  const auth = await getTokenFeam(apiBase, form.auth || {});
  const headers = headersFeam(auth);

  const lista = await apiFetch(`${apiBase}/retornaListaCodigoBarasManifesto/${inicio}/${fim}`, { headers });
  if (lista?.retornoCodigo !== undefined && lista.retornoCodigo !== 0) {
    return vazio(`❌ Erro ${lista.retornoCodigo}: ${lista.retorno}`);
  }

  const codigos = lista?.codigos || [];
  if (!codigos.length) {
    return { sucesso: true, total: 0, totalPendentes: 0, manifests: [], mensagem: '✅ Nenhum MTR encontrado no período' };
  }

  const numeros = codigos.map(numeroDoBarcode);
  const buscados = await emLotes(numeros, LOTE, num =>
    apiFetch(`${apiBase}/retornaManifestoPorNumero/${encodeURIComponent(num)}`, { headers })
  );

  const todos = buscados.filter(m => m && typeof m === 'object' && m.manifestoCodigo !== undefined);
  const manifests = todos
    .filter(m => m.situacaoManifestoCodigo === 1)      // 1 = emitido, aguardando baixa
    .map(normalizaManifestoFeam);

  return {
    sucesso: true,
    total: todos.length,
    totalPendentes: manifests.length,
    manifests,
    mensagem: `✅ ${manifests.length} MTR(s) pendente(s) de baixa (de ${todos.length} no período)`,
  };
}

// Traduz o manifesto da API antiga para os campos que a tela usa.
function normalizaManifestoFeam(m) {
  return {
    manifestoCodigo:    m.manifestoCodigo,
    manifDataExpedicao: m.manifDataExpedicao || m.manifData,
    cnpGerador:         m.cnpGerador,
    cnpTransportador:   m.cnpTransportador,
    cnpDestinador:      m.cnpDestinador,
    nomeMotorista:      m.manifTransportadorNomeMotorista || '',
    placaVeiculo:       m.manifTransportadorPlacaVeiculo  || '',
    situacaoManifestoCodigo: m.situacaoManifestoCodigo,
    situacao: SITUACOES[m.situacaoManifestoCodigo] || `Situação ${m.situacaoManifestoCodigo}`,
    itens: (m.itemManifestoJSONs || []).map(it => ({
      codigoSequencial: it.codigoSequencial,
      residuo:          it.residuo,
      quantidade:       it.quantidade,
      codigoUnidade:    it.codigoUnidade,
      codigoTecnologia: it.codigoTecnologia,
      codigoTipoEstado: it.codigoTipoEstado,
    })),
  };
}

// Busca por número (API antiga). Devolve o MTR em qualquer situação — quem
// decide se dá para baixar é a tela. Uma falha isolada (timeout de um número)
// não derruba o lote: o número volta em `semResposta` para nova tentativa.
async function consultaFeamPorNumero(apiBase, form) {
  const numeros = [...new Set((form.numeros || []).map(soDigitos).filter(Boolean))];
  if (!numeros.length) return vazio('❌ Nenhum número de MTR informado.');
  if (numeros.length > MAX_NUMEROS) {
    return vazio(`❌ Máximo de ${MAX_NUMEROS} números por consulta (vieram ${numeros.length}).`);
  }

  const auth = await getTokenFeam(apiBase, form.auth || {});
  const headers = headersFeam(auth);

  const respostas = await emLotes(numeros, LOTE, num =>
    apiFetch(`${apiBase}/retornaManifestoPorNumero/${encodeURIComponent(num)}`, { headers })
      .catch(() => SEM_RESPOSTA)
  );

  const manifests = [], naoEncontrados = [], semResposta = [];
  respostas.forEach((m, i) => {
    if (m === SEM_RESPOSTA) semResposta.push(numeros[i]);
    else if (m && typeof m === 'object' && m.manifestoCodigo !== undefined) manifests.push(normalizaManifestoFeam(m));
    else naoEncontrados.push(numeros[i]);
  });

  return respostaPorNumero(manifests, naoEncontrados, semResposta);
}

function respostaPorNumero(manifests, naoEncontrados, semResposta) {
  const partes = [`${manifests.length} MTR(s) carregado(s)`];
  if (naoEncontrados.length) partes.push(`${naoEncontrados.length} não encontrado(s)`);
  if (semResposta.length)    partes.push(`${semResposta.length} sem resposta do órgão`);
  return {
    sucesso: true,
    total: manifests.length,
    totalPendentes: manifests.filter(m => Number(m.situacaoManifestoCodigo) === 1).length,
    manifests, naoEncontrados, semResposta,
    mensagem: (manifests.length ? '✅ ' : '❌ ') + partes.join(' — '),
  };
}

// Barcode real tem 43 chars: 9 de prefixo + 10 do nº do manifesto + 3×8 de unidades.
function numeroDoBarcode(barcode) {
  const s = String(barcode);
  return s.length >= 19 ? s.substring(9, 19) : s.substring(0, 10);
}

// ── API nova (SINIR / INEA): busca por número ────────────────────────────────

async function consultaSinir(apiBase, form) {
  const numeros = (form.numeros || []).map(soDigitos).filter(Boolean);
  if (!numeros.length) return vazio('❌ Nenhum número de MTR informado.');

  const token = await getTokenSinir(apiBase, form.auth || {});
  const headers = headersSinir(token);

  const respostas = await emLotes(numeros, LOTE, num =>
    apiFetch(`${apiBase}/retornaManifesto/${encodeURIComponent(num)}`, { method: 'GET', headers })
  );

  const manifests = [], naoEncontrados = [];
  let falhas = 0;
  respostas.forEach((resposta, i) => {
    const m = resposta?.objetoResposta;
    if (!m || !m.manNumero) { falhas++; naoEncontrados.push(numeros[i]); return; }
    manifests.push(normalizaManifestoSinir(m));
  });

  if (!manifests.length) {
    return { ...vazio(`❌ Nenhum MTR encontrado (${falhas} número(s) não retornaram dados). Confira os números.`), naoEncontrados };
  }

  return {
    sucesso: true,
    total: manifests.length,
    totalPendentes: manifests.length,
    manifests, naoEncontrados,
    mensagem: `✅ ${manifests.length} MTR(s) carregado(s)` + (falhas ? ` — ${falhas} não encontrado(s)` : ''),
  };
}

// Traduz o retorno da API nova para os mesmos campos da API antiga.
function normalizaManifestoSinir(m) {
  const situacao     = m.situacaoManifesto     || {};
  const gerador      = m.parceiroGerador       || {};
  const transportador = m.parceiroTransportador || {};
  const destinador   = m.parceiroDestinador    || {};

  return {
    manifestoCodigo:    m.manNumero,
    manifDataExpedicao: m.manDataExpedicao || m.manData,
    cnpGerador:         soDigitos(gerador.parCnpj),
    cnpTransportador:   soDigitos(transportador.parCnpj),
    cnpDestinador:      soDigitos(destinador.parCnpj),
    nomeGerador:        gerador.parDescricao        || '',
    nomeTransportador:  transportador.parDescricao  || '',
    nomeMotorista: textoOuVazio(m.manNomeMotorista),
    placaVeiculo:  textoOuVazio(m.manPlacaVeiculo),
    situacaoManifestoCodigo: situacao.simCodigo,
    situacao: situacao.simDescricao || `Situação ${situacao.simCodigo}`,
    itens: (m.listaManifestoResiduo || []).map(r => ({
      codigoSequencial: r.marCodigoInterno || null,
      residuo:          r.residuo?.resCodigoIbama || r.resCodigoIbama || '',
      quantidade:       r.marQuantidade,
      codigoUnidade:    r.unidade?.uniCodigo || r.uniCodigo || null,
      unidadeSigla:     r.unidade?.uniSigla || r.unidade?.uniDescricao || '',
      codigoTecnologia: r.tratamento?.traCodigo || r.traCodigo || null,
      codigoTipoEstado: r.tipoEstado?.tieCodigo || r.tieCodigo || null,
      codigoClasse:     r.classe?.claCodigo || r.claCodigo || null,
      codigoAcondicionamento: r.tipoAcondicionamento?.tiaCodigo || r.tiaCodigo || null,
    })),
  };
}

// A API nova manda a string 'empty' quando o campo está em branco.
const textoOuVazio = v => (v && v !== 'empty' ? v : '');

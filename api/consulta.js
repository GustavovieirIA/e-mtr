// POST /api/consulta — lista MTRs para dar baixa.
// Substitui os workflows "MTR-MG - 3. Consultar Pendentes" e "MTR-SINIR - 3. Consultar Pendentes".
//
// Os dois dialetos devolvem o MESMO formato ({ manifests: [...] }, campos estilo
// FEAM), para a mesma tabela da tela servir aos dois.
import {
  MtrError, apiFetch, validarApiBase,
  getTokenFeam, headersFeam, getTokenSinir, headersSinir,
  corpoJSON, respostaJSON, soDigitos, emLotes,
} from '../lib/mtr.js';

// A consulta do FEAM faz uma requisição por manifesto do período; em lotes para
// não abrir dezenas de conexões simultâneas contra a API do órgão.
const LOTE = 6;

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
    .map(m => ({
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
    }));

  return {
    sucesso: true,
    total: todos.length,
    totalPendentes: manifests.length,
    manifests,
    mensagem: `✅ ${manifests.length} MTR(s) pendente(s) de baixa (de ${todos.length} no período)`,
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

  const manifests = [];
  let falhas = 0;
  for (const resposta of respostas) {
    const m = resposta?.objetoResposta;
    if (!m || !m.manNumero) { falhas++; continue; }
    manifests.push(normalizaManifestoSinir(m));
  }

  if (!manifests.length) {
    return vazio(`❌ Nenhum MTR encontrado (${falhas} número(s) não retornaram dados). Confira os números.`);
  }

  return {
    sucesso: true,
    total: manifests.length,
    totalPendentes: manifests.length,
    manifests,
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

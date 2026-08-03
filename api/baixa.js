// POST /api/baixa — registra o recebimento (baixa) de um MTR.
// Substitui os workflows "MTR-MG - 2. Dar Baixa" e "MTR-SINIR - 2. Dar Baixa".
import {
  MtrError, apiFetch, validarApiBase,
  getTokenFeam, headersFeam, getTokenSinir, headersSinir,
  corpoJSON, respostaTexto, soDigitos, documentoOuNulo,
  inteiroOuNulo, decimalOuNulo, inteiroOuZero, decimalOuZero,
  dataParaEpoch, resumo,
} from '../lib/mtr.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return respostaTexto(res, '❌ Método não permitido.', 405);

  const form = corpoJSON(req);
  try {
    const apiBase = validarApiBase(form.apiBase);
    const mensagem = form.dialect === 'sinir'
      ? await baixaSinir(apiBase, form)
      : await baixaFeam(apiBase, form);
    return respostaTexto(res, mensagem);
  } catch (err) {
    if (err instanceof MtrError) return respostaTexto(res, `❌ ${err.message}`);
    return respostaTexto(res, `❌ Erro inesperado na baixa: ${err.message}`, 500);
  }
}

// ── API antiga (FEAM-MG) ─────────────────────────────────────────────────────

async function baixaFeam(apiBase, form) {
  const auth = await getTokenFeam(apiBase, form.auth || {});
  const resposta = await apiFetch(`${apiBase}/receberManifestoLote`, {
    headers: headersFeam(auth),
    body: JSON.stringify({ manifestoRecebimentoJSONs: [montarRecebimentoFeam(form)] }),
  });

  const r = resposta?.manifestoRecebimentoJSONs?.[0];
  if (!r) return `❌ Resposta inesperada da API: ${resumo(resposta)}`;
  return r.retornoCodigo === 0
    ? `✅ Baixa do MTR ${r.manifestoCodigo} registrada com sucesso!`
    : `❌ Erro ${r.retornoCodigo}: ${r.retorno}`;
}

function montarRecebimentoFeam(form) {
  // A baixa inline da consulta manda itens[]; a aba manual e a baixa em massa
  // mandam um resíduo só, em campos soltos.
  const itens = Array.isArray(form.itens)
    ? form.itens.map((it, i) => ({
        codigoSequencial: it.codigoSequencial || (i + 1),
        justificativa:    null,
        codigoInterno:    null,
        qtdRecebida:      decimalOuNulo(it.qtdRecebida),
        residuo:          it.residuo,
        codigoTecnologia: inteiroOuNulo(it.codigoTecnologia),
        codigoTipoEstado: inteiroOuNulo(it.codigoTipoEstado),
      }))
    : [{
        codigoSequencial: 1,
        justificativa:    null,
        codigoInterno:    null,
        qtdRecebida:      decimalOuNulo(form['Quantidade Recebida']),
        residuo:          form['Código do Resíduo (IBAMA)'],
        codigoTecnologia: inteiroOuNulo(form['Código de Tecnologia']),
        codigoTipoEstado: inteiroOuNulo(form['Código de Estado Físico']),
      }];

  return {
    manifestoCodigo:           form['Número do Manifesto (10 dígitos)'],
    cnpGerador:                documentoOuNulo(form['CNPJ do Gerador']),
    cnpTransportador:          documentoOuNulo(form['CNPJ do Transportador']),
    recebimentoMtrResponsavel: form['Nome do Responsável pelo Recebimento'],
    recebimentoMtrCargo:       form['Cargo do Responsável'],
    recebimentoMtrData:        form['Data de Recebimento (AAAAMMDD)'],
    recebimentoMtrObs:         form['Observações do Recebimento'] || '',
    nomeMotorista:             form['Nome do Motorista'],
    placaVeiculo:              form['Placa do Veículo'],
    itemManifestoRecebimentoJSONs: itens,
  };
}

// ── API nova (SINIR / INEA) ──────────────────────────────────────────────────

async function baixaSinir(apiBase, form) {
  const numero = soDigitos(form.manNumero);
  if (!numero) return '❌ Número do MTR não informado.';

  const token = await getTokenSinir(apiBase, form.auth || {});

  // O recebimento exige os códigos internos de cada resíduo (traCodigo, uniCodigo,
  // tieCodigo…). Eles não existem na tela, então buscamos o manifesto e reusamos
  // os códigos que a própria API devolve — só a quantidade e a data vêm do site.
  const consulta = await apiFetch(`${apiBase}/retornaManifesto/${encodeURIComponent(numero)}`, {
    method: 'GET',
    headers: headersSinir(token),
  });

  const manifesto = consulta?.objetoResposta || {};
  const residuos  = manifesto.listaManifestoResiduo || [];
  if (!residuos.length) {
    return `❌ MTR ${numero}: a consulta não retornou resíduos (número errado ou sem acesso a este MTR).`;
  }

  const itensPedidos = Array.isArray(form.itens) ? form.itens : [];
  const qtdUnica = (form.qtdRecebida != null && form.qtdRecebida !== '') ? decimalOuZero(form.qtdRecebida) : null;
  const justificativa = form.justificativa || form.observacoes || 'Peso apurado em balanca';

  const lista = residuos.map((r, i) => {
    const pedido = itensPedidos[i] || {};
    const recebida = (pedido.marQuantidadeRecebida != null && pedido.marQuantidadeRecebida !== '')
      ? decimalOuZero(pedido.marQuantidadeRecebida)
      : (qtdUnica != null ? qtdUnica : decimalOuZero(r.marQuantidade));
    return {
      resCodigoIbama:        String(r.residuo?.resCodigoIbama || ''),
      marQuantidade:         decimalOuZero(r.marQuantidade),
      marQuantidadeRecebida: recebida,
      traCodigo:             inteiroOuZero(r.tratamento?.traCodigo),
      uniCodigo:             inteiroOuZero(r.unidade?.uniCodigo),
      marJustificativa:      justificativa,
      tieCodigo:             inteiroOuZero(r.tipoEstado?.tieCodigo),
      tiaCodigo:             inteiroOuZero(r.tipoAcondicionamento?.tiaCodigo),
      claCodigo:             inteiroOuZero(r.classe?.claCodigo),
    };
  });

  const payload = {
    manNumero:                  String(form.manNumero),
    dataRecebimento:            dataParaEpoch(form.dataRecebimento),
    nomeMotorista:              String(form.nomeMotorista || '').toUpperCase(),
    placaVeiculo:               String(form.placaVeiculo || '').toUpperCase(),
    nomeResponsavelRecebimento: form.nomeResponsavelRecebimento || '',
    observacoes:                form.observacoes || '',
    listaManifestoResiduos:     lista,
  };

  const resposta = await apiFetch(`${apiBase}/receberManifestoLote`, {
    headers: headersSinir(token),
    body: JSON.stringify([payload]),
  });

  const bruto = resposta?.objetoResposta;
  const r = Array.isArray(bruto) ? (bruto[0] || {}) : (bruto || {});
  const valido = r.restResponseValido === true && (resposta?.erro === false || resposta?.erro === undefined);
  if (valido) return `✅ Baixa do MTR ${r.manNumero || numero} registrada com sucesso!`;

  const msgApi = r.restResponseMensagem || resposta?.mensagem || '';
  return `❌ Erro na baixa do MTR ${numero}: ${msgApi || resumo(resposta)}`;
}

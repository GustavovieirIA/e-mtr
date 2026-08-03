// POST /api/emitir — emite um MTR. Substitui o workflow "MTR-MG - 1. Emitir Manifesto".
import {
  MtrError, apiFetch, validarApiBase, getTokenFeam, headersFeam,
  corpoJSON, respostaTexto, documentoOuNulo, inteiroOuNulo, decimalOuNulo, resumo,
} from '../lib/mtr.js';

// Somos sempre o destinador do MTR que emitimos — União Recicláveis.
const DESTINADOR = { cnpj: '07711109000186', codUnidade: 255271 };

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return respostaTexto(res, '❌ Método não permitido.', 405);

  const form = corpoJSON(req);
  try {
    const apiBase = validarApiBase(form.apiBase);

    if (form.dialect === 'sinir') {
      return respostaTexto(res,
        '❌ Emissão de MTR ainda não está disponível para SINIR/INEA — emita pelo portal do órgão.');
    }

    const auth = await getTokenFeam(apiBase, form.auth || {});
    const resposta = await apiFetch(`${apiBase}/salvarManifestoLote`, {
      headers: headersFeam(auth),
      body: JSON.stringify(montarEmissao(form)),
    });

    const r = resposta?.manifestoJSONDtos?.[0];
    if (!r) return respostaTexto(res, `❌ Resposta inesperada da API: ${resumo(resposta)}`);

    return respostaTexto(res, r.retornoCodigo === 0
      ? `✅ MTR ${r.manifestoCodigo} emitido com sucesso!`
      : `❌ Erro ${r.retornoCodigo}: ${r.retorno}`);
  } catch (err) {
    if (err instanceof MtrError) return respostaTexto(res, `❌ ${err.message}`);
    return respostaTexto(res, `❌ Erro inesperado ao emitir: ${err.message}`, 500);
  }
}

function montarEmissao(form) {
  const unidadeMedida = inteiroOuNulo(form['Código de Unidade de Medida']);
  return {
    manifestoJSONDtos: [{
      cnpGerador:              documentoOuNulo(form['CNPJ do Gerador']),
      codUnidadeGerador:       inteiroOuNulo(form['Código da Unidade do Gerador']),
      cnpDestinador:           DESTINADOR.cnpj,
      codUnidadeDestinador:    DESTINADOR.codUnidade,
      cnpTransportador:        documentoOuNulo(form['CNPJ do Transportador']),
      codUnidadeTransportador: inteiroOuNulo(form['Código da Unidade do Transportador']),
      cnpArmazenador:          null,
      codUnidadeArmazenador:   null,
      seuCodigoReferencia:     form['Seu Código de Referência'] || null,
      manifObservacao:         form['Observações'] || '',
      manifGeradorNomeResponsavel:     form['Nome do Responsável'],
      manifGeradorCargoResponsavel:    form['Cargo do Responsável'],
      manifTransportadorNomeMotorista: form['Nome do Motorista'] || null,
      manifTransportadorPlacaVeiculo:  form['Placa do Veículo'] || null,
      manifTransportadorDataExpedicao: form['Data de Expedição (AAAAMMDD)'] || null,
      itemManifestoJSONs: [{
        quantidade:             decimalOuNulo(form['Quantidade']),
        residuo:                form['Código do Resíduo (IBAMA)'],
        codigoAcondicionamento: inteiroOuNulo(form['Código de Acondicionamento']),
        codigoClasse:           inteiroOuNulo(form['Código de Classe']),
        codigoTecnologia:       inteiroOuNulo(form['Código de Tecnologia']),
        codigoTipoEstado:       inteiroOuNulo(form['Código de Estado Físico']),
        codigoUnidade:          unidadeMedida,
        manifestoItemObservacao:          '',
        manifestoItemCodInterno:          '',
        manifestoItemCodInternoDestinador: '',
        tipoDensidadeValor:   1,
        tipoDensidadeUnidade: unidadeMedida === 2 ? 2 : 1,
      }],
    }],
  };
}

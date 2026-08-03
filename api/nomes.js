// POST /api/nomes — razão social a partir do CNPJ, via BrasilAPI.
//
// A API do FEAM devolve só o CNPJ do gerador e do transportador. A BrasilAPI
// resolve o nome, mas bloqueia o IP com 403 por vários minutos quando recebe
// uma rajada — e o bloqueio não avisa com 429 nem com Retry-After.
//
// Por isso aqui: uma requisição de cada vez, com pausa; ao primeiro 403 desiste
// do resto e devolve como `pendentes`, em vez de insistir e prolongar o bloqueio.
// O que foi resolvido fica em cache (aqui e no navegador), e razão social não
// muda — então o custo tende a zero conforme os mesmos CNPJs se repetem.
import { corpoJSON, soDigitos } from '../lib/mtr.js';

const cache = new Map();

const PAUSA_MS     = 700;    // ~1,4 req/s contra a BrasilAPI
const ORCAMENTO_MS = 15000;  // tempo máximo buscando; o resto volta como pendente
const TIMEOUT_MS   = 8000;

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ nomes: {}, pendentes: [] });

  const { cnpjs = [] } = corpoJSON(req);
  const alvos = [...new Set((Array.isArray(cnpjs) ? cnpjs : []).map(soDigitos))]
    .filter(c => c.length === 14);

  const nomes = {};
  const pendentes = [];
  const inicio = Date.now();
  let bloqueado = false;

  for (const cnpj of alvos) {
    if (cache.has(cnpj))                      { nomes[cnpj] = cache.get(cnpj); continue; }
    if (bloqueado || Date.now() - inicio > ORCAMENTO_MS) { pendentes.push(cnpj); continue; }

    if (Object.keys(nomes).length) await espera(PAUSA_MS);

    const nome = await buscaNome(cnpj);
    if (nome === null) { bloqueado = true; pendentes.push(cnpj); continue; }

    cache.set(cnpj, nome);
    nomes[cnpj] = nome;
  }

  res.status(200).json({ nomes, pendentes });
}

/** Nome da empresa, '' quando o CNPJ não existe, null quando não deu para saber. */
async function buscaNome(cnpj) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 403 || r.status === 429) return null;  // IP bloqueado — para tudo
  if (r.status === 404) return '';                        // CNPJ não existe — vale cachear
  if (!r.ok) return null;

  try {
    const d = await r.json();
    return d.razao_social || '';
  } catch {
    return null;
  }
}

const espera = ms => new Promise(r => setTimeout(r, ms));

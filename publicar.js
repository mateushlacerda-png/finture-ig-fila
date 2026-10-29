// Publica no Instagram os posts da fila cujo horario ja chegou. Roda no GitHub Actions.
//
// fila/<pasta>/post.json   { rotulo, publicar_em, imagens: [...jpg], legenda }
// fila/<pasta>/publicado.json  gravado depois que sai (impede publicar duas vezes)
// fila/<pasta>/erro.json       tentativas que falharam; desiste depois de MAX_TENTATIVAS
//
// Env: IG_ACCESS_TOKEN, IG_USER_ID (secrets do repo), GITHUB_REPOSITORY, GITHUB_SHA.

const fs = require('fs');
const path = require('path');

const API = 'https://graph.facebook.com/v24.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const USER = process.env.IG_USER_ID;
const REPO = process.env.GITHUB_REPOSITORY;
const MAX_TENTATIVAS = 3;
const FILA = path.join(__dirname, 'fila');

if (!TOKEN || !USER) { console.error('Faltam os secrets IG_ACCESS_TOKEN e IG_USER_ID.'); process.exit(1); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(metodo, caminho, params = {}) {
  const corpo = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = `${API}/${caminho}`;
  const r = metodo === 'GET'
    ? await fetch(url + '?' + corpo)
    : await fetch(url, { method: 'POST', body: corpo });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${caminho}: ${e.message || 'HTTP ' + r.status}${e.error_user_msg ? ' / ' + e.error_user_msg : ''}`);
  }
  return j;
}

// O container precisa estar FINISHED antes de entrar no carrossel ou ser publicado.
async function aguardarContainer(id) {
  for (let i = 0; i < 30; i++) {
    const { status_code: s } = await api('GET', id, { fields: 'status_code' });
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`container ${id} ficou ${s}`);
    await espera(4000);
  }
  throw new Error(`container ${id} nao ficou pronto em 2 min`);
}

// Rede de seguranca: se uma rodada anterior publicou mas nao conseguiu gravar o publicado.json,
// a legenda ja esta no perfil. Nesse caso so registra, nao publica de novo.
async function jaNoPerfil(legenda) {
  const { data = [] } = await api('GET', `${USER}/media`, { fields: 'id,caption,permalink,timestamp', limit: '12' });
  const alvo = legenda.trim();
  return data.find((m) => (m.caption || '').trim() === alvo);
}

async function publicar(pasta, post) {
  const base = `https://raw.githubusercontent.com/${REPO}/${process.env.GITHUB_SHA}/fila/${pasta}/`;
  let criacao;
  if (post.imagens.length === 1) {
    ({ id: criacao } = await api('POST', `${USER}/media`, { image_url: base + post.imagens[0], caption: post.legenda }));
  } else {
    const filhos = [];
    for (const img of post.imagens) {
      const { id } = await api('POST', `${USER}/media`, { image_url: base + img, is_carousel_item: 'true' });
      await aguardarContainer(id);
      filhos.push(id);
    }
    ({ id: criacao } = await api('POST', `${USER}/media`, {
      media_type: 'CAROUSEL', children: filhos.join(','), caption: post.legenda,
    }));
  }
  await aguardarContainer(criacao);
  const { id } = await api('POST', `${USER}/media_publish`, { creation_id: criacao });
  const { permalink } = await api('GET', id, { fields: 'permalink' });
  return { media_id: id, permalink };
}

(async () => {
  if (!fs.existsSync(FILA)) { console.log('Fila vazia.'); return; }
  let falhou = false;
  const pastas = fs.readdirSync(FILA).sort();
  for (const pasta of pastas) {
    const dir = path.join(FILA, pasta);
    const arqPost = path.join(dir, 'post.json');
    if (!fs.existsSync(arqPost) || fs.existsSync(path.join(dir, 'publicado.json'))) continue;
    const post = JSON.parse(fs.readFileSync(arqPost, 'utf8'));
    if (Date.parse(post.publicar_em) > Date.now()) continue;

    const arqErro = path.join(dir, 'erro.json');
    const erro = fs.existsSync(arqErro) ? JSON.parse(fs.readFileSync(arqErro, 'utf8')) : { tentativas: 0 };
    if (erro.tentativas >= MAX_TENTATIVAS) continue;

    try {
      const existente = await jaNoPerfil(post.legenda);
      const r = existente
        ? { media_id: existente.id, permalink: existente.permalink, recuperado: true }
        : await publicar(pasta, post);
      fs.writeFileSync(path.join(dir, 'publicado.json'),
        JSON.stringify({ ...r, publicado_em: new Date().toISOString() }, null, 2) + '\n');
      // Depois de publicado, a imagem ja esta no Instagram: tira os JPEGs do repo.
      for (const img of post.imagens) fs.rmSync(path.join(dir, img), { force: true });
      fs.rmSync(arqErro, { force: true });
      console.log(`PUBLICADO  ${post.rotulo}  ${r.permalink}${r.recuperado ? '  (ja estava no perfil)' : ''}`);
    } catch (e) {
      falhou = true;
      erro.tentativas += 1;
      erro.ultimo_erro = e.message;
      erro.quando = new Date().toISOString();
      fs.writeFileSync(arqErro, JSON.stringify(erro, null, 2) + '\n');
      console.error(`FALHOU  ${post.rotulo}  tentativa ${erro.tentativas}/${MAX_TENTATIVAS}: ${e.message}`);
    }
  }
  // Execucao com falha = GitHub manda e-mail ao dono do repo.
  if (falhou) process.exit(1);
})();

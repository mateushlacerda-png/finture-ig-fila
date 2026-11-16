// Publica no Instagram os posts da fila cujo horario ja chegou. Roda no GitHub Actions.
//
// fila/<pasta>/post.json   { rotulo, publicar_em, imagens: [...jpg], legenda }
//                          reel: { tipo: 'reel', rotulo, publicar_em, video: 'video.mp4', capa: 'capa.jpg',
//                                  imagens: ['video.mp4', 'capa.jpg'] (apagados depois), legenda }
//                          story: { tipo: 'story', rotulo, ancora, publicar_em, imagens: ['story.jpg'] }, sem legenda
//                          linkedin: { tipo: 'linkedin', rotulo, ancora, publicar_em, documento: 'carrossel.pdf',
//                                      imagens: ['carrossel.pdf'] (apagado depois), titulo, legenda }
// fila/<pasta>/publicado.json  gravado depois que sai (impede publicar duas vezes)
// fila/<pasta>/erro.json       tentativas que falharam; desiste depois de MAX_TENTATIVAS
//
// Env: IG_ACCESS_TOKEN, IG_USER_ID (secrets do repo), GITHUB_REPOSITORY, GITHUB_SHA.
//      LI_ACCESS_TOKEN, LI_ORG_URN (secrets, renovados toda sexta pelo linkedin-token.js local).

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
// Video (Reel) leva mais: o Instagram transcodifica antes de liberar.
async function aguardarContainer(id, tentativas = 30) {
  for (let i = 0; i < tentativas; i++) {
    const { status_code: s, status } = await api('GET', id, { fields: 'status_code,status' });
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`container ${id} ficou ${s}${status ? ' (' + status + ')' : ''}`);
    await espera(4000);
  }
  throw new Error(`container ${id} nao ficou pronto em ${Math.round(tentativas * 4 / 60)} min`);
}

// Reel: o Instagram baixa o MP4 pela URL do raw.githubusercontent, como faz com as imagens.
// Testado em 06/11/2026 sem publicar: container FINISHED em ~20 s. O upload resumable (rupload)
// devolveu ProcessingFailedError nesta conta e foi descartado.
async function criarReel(base, post) {
  const params = { media_type: 'REELS', video_url: base + post.video, caption: post.legenda, share_to_feed: 'true' };
  if (post.capa) params.cover_url = base + post.capa;
  const { id } = await api('POST', `${USER}/media`, params);
  return id;
}

// Rede de seguranca: se uma rodada anterior publicou mas nao conseguiu gravar o publicado.json,
// a legenda ja esta no perfil. Nesse caso so registra, nao publica de novo.
async function jaNoPerfil(legenda) {
  const { data = [] } = await api('GET', `${USER}/media`, { fields: 'id,caption,permalink,timestamp', limit: '12' });
  const alvo = legenda.trim();
  return data.find((m) => (m.caption || '').trim() === alvo);
}

// Story nao tem legenda para comparar. Rede de seguranca: um story ativo publicado depois do horario
// marcado conta como este. Risco aceito: um story manual postado nesse intervalo, numa rodada que
// tinha falhado, faria este ser dado como publicado (fica registrado com recuperado: true).
async function storyJaNoPerfil(publicarEm) {
  const { data = [] } = await api('GET', `${USER}/stories`, { fields: 'id,permalink,timestamp' });
  const desde = Date.parse(publicarEm);
  return data.find((m) => Date.parse(String(m.timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= desde);
}

// ---------------------------------------------------------------------------------------------
// LinkedIn (desde 2026-11-16): pagina da Finture, post de documento (o carrossel em PDF), pela
// Community Management API. O PDF sobe do proprio checkout, sem URL publica.
const LI_TOKEN = process.env.LI_ACCESS_TOKEN;
const LI_ORG = process.env.LI_ORG_URN; // urn:li:organization:NNN
const LI_VERSAO = process.env.LI_VERSION || '202610'; // cada versao vale ~1 ano; ver README
const LI_API = 'https://api.linkedin.com/rest';

async function li(metodo, caminho, corpo, extra = {}) {
  if (!LI_TOKEN || !LI_ORG) throw new Error('Faltam os secrets LI_ACCESS_TOKEN e LI_ORG_URN.');
  const r = await fetch(`${LI_API}/${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${LI_TOKEN}`, 'LinkedIn-Version': LI_VERSAO, 'X-Restli-Protocol-Version': '2.0.0',
      ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...extra,
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let j = {};
  try { j = texto ? JSON.parse(texto) : {}; } catch { /* corpo nao-JSON */ }
  if (!r.ok) throw new Error(`linkedin ${caminho.split('?')[0]}: HTTP ${r.status} ${j.message || texto.slice(0, 200)}`);
  return { j, headers: r.headers };
}

// O texto do post usa o formato "little" do LinkedIn: caractere reservado sem barra invertida corta
// o texto ou vira marcacao (os parenteses do telefone, o @ do e-mail). Hashtag continua hashtag.
function littleText(t) {
  return t.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => '\\' + c).replace(/\\#(?=[\p{L}\p{N}_])/gu, '#');
}

// Rede de seguranca, como no Instagram: o texto ja esta num post recente da pagina = ja saiu.
async function jaNoLinkedin(legenda) {
  const { j } = await li('GET', `posts?author=${encodeURIComponent(LI_ORG)}&q=author&count=10&sortBy=LAST_MODIFIED`,
    null, { 'X-RestLi-Method': 'FINDER' });
  const alvos = [legenda.trim(), littleText(legenda).trim()];
  const p = (j.elements || []).find((e) => alvos.includes((e.commentary || '').trim()));
  return p ? { id: p.id, permalink: `https://www.linkedin.com/feed/update/${p.id}/` } : null;
}

async function publicarLinkedin(dir, post) {
  const { j: init } = await li('POST', 'documents?action=initializeUpload', { initializeUploadRequest: { owner: LI_ORG } });
  const { uploadUrl, document } = init.value || {};
  if (!uploadUrl || !document) throw new Error('linkedin documents: initializeUpload sem uploadUrl');
  const up = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${LI_TOKEN}` },
    body: fs.readFileSync(path.join(dir, post.documento)) });
  if (!up.ok) throw new Error(`linkedin upload do PDF: HTTP ${up.status}`);
  for (let i = 0; ; i++) {
    const { j } = await li('GET', `documents/${encodeURIComponent(document)}`);
    if (j.status === 'AVAILABLE') break;
    if (j.status === 'PROCESSING_FAILED') throw new Error('linkedin: processamento do PDF falhou');
    if (i >= 45) throw new Error(`linkedin: PDF nao ficou disponivel em 3 min (status ${j.status})`);
    await espera(4000);
  }
  const { headers } = await li('POST', 'posts', {
    author: LI_ORG,
    commentary: littleText(post.legenda),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { title: post.titulo, id: document } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });
  const id = headers.get('x-restli-id');
  return { media_id: id, permalink: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
}

async function publicar(pasta, post) {
  const base = `https://raw.githubusercontent.com/${REPO}/${process.env.GITHUB_SHA}/fila/${pasta}/`;
  let criacao;
  if (post.tipo === 'reel') {
    criacao = await criarReel(base, post);
    await aguardarContainer(criacao, 150); // ate 10 min; o job tem 15
  } else if (post.tipo === 'story') {
    ({ id: criacao } = await api('POST', `${USER}/media`, { image_url: base + post.imagens[0], media_type: 'STORIES' }));
  } else if (post.imagens.length === 1) {
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
  // Story pode nao devolver permalink; o registro nao depende dele.
  const { permalink = null } = await api('GET', id, { fields: 'permalink' }).catch(() => ({}));
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
      const existente = post.tipo === 'linkedin' ? await jaNoLinkedin(post.legenda)
        : post.tipo === 'story' ? await storyJaNoPerfil(post.publicar_em) : await jaNoPerfil(post.legenda);
      const r = existente
        ? { media_id: existente.id, permalink: existente.permalink, recuperado: true }
        : post.tipo === 'linkedin' ? await publicarLinkedin(dir, post) : await publicar(pasta, post);
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

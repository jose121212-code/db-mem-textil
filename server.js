const express = require('express');
const { Pool } = require('pg'); // Conector do Supabase
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.set('trust proxy', true); // Render fica atrás de um proxy: garante links https nas fotos

// A connection string do Supabase vem da variável de ambiente DATABASE_URL.
// NUNCA coloque a senha do banco aqui no código: o repositório fica no GitHub.
// Configure em: Render > seu serviço > Environment > DATABASE_URL
// Pegue o valor em: Supabase > Project Settings > Database > Connection String (URI)
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('ERRO: variável de ambiente DATABASE_URL não foi definida. Configure-a no painel do Render (Environment) com a connection string do Supabase.');
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

// Login do modo administrador (pode ser trocado no Render sem mexer no código:
// variáveis ADMIN_EMAIL e ADMIN_SENHA)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'memtextil@gmail.com';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'memtextil123';

// Colunas json/jsonb no Postgres já vêm parseadas pelo driver "pg".
// Colunas text/varchar vêm como string e precisam de JSON.parse.
function parseMaybeJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (e) { return fallback; }
    }
    return value;
}

// PING: rota leve para o cron-job.org manter o Render acordado e o Supabase ativo
app.get('/api/ping', async (req, res) => {
    try {
        await pool.query("SELECT id FROM produtos LIMIT 1");
        res.status(200).json({ ok: true, hora: new Date().toISOString() });
    } catch (err) {
        console.error('Erro no ping:', err.message);
        res.status(500).json({ ok: false });
    }
});

// LOGIN DO ADMIN (aceita o campo "email" ou "username")
app.post('/api/login', (req, res) => {
    const { email, username, password } = req.body || {};
    const usuario = String(email || username || '').trim().toLowerCase();

    if (usuario === ADMIN_EMAIL.toLowerCase() && password === ADMIN_SENHA) {
        return res.status(200).json({ message: "Login realizado com sucesso!" });
    }
    return res.status(401).json({ message: "E-mail ou senha incorretos." });
});

// ==========================================
// CATÁLOGO (PRODUTOS)
// ==========================================
// As fotos continuam guardadas no banco, mas a vitrine não recebe mais o base64.
// A listagem devolve só links, e cada foto é servida por uma rota própria,
// em tamanho reduzido e com cache no navegador. Isso deixa o catálogo muito
// mais rápido e economiza a cota de tráfego do Supabase.

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('sharp indisponível: fotos serão servidas no tamanho original.'); }

const colunasExtras = { categoria: false, selo: false };

async function prepararBancoProdutos() {
    for (const col of ['categoria', 'selo']) {
        try {
            await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ${col} TEXT`);
        } catch (e) {
            console.warn(`Não foi possível criar a coluna ${col}:`, e.message);
        }
    }
    try {
        const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'produtos'");
        const cols = r.rows.map(x => x.column_name);
        colunasExtras.categoria = cols.includes('categoria');
        colunasExtras.selo = cols.includes('selo');
    } catch (e) {
        console.warn('Não foi possível ler as colunas de produtos:', e.message);
    }
}
const bancoPronto = prepararBancoProdutos();

// Expressão que transforma a coluna images em JSON com segurança (text ou jsonb)
const IMAGES_JSON = "NULLIF(images::text, '')::json";

function urlBase(req) {
    return `${req.protocol}://${req.get('host')}`;
}

// Cache em memória das fotos já processadas (limite de ~80 MB)
const cacheFotos = new Map();
let cacheBytes = 0;
const CACHE_MAX = 80 * 1024 * 1024;

function guardarNoCache(chave, valor) {
    if (valor.buffer.length > 8 * 1024 * 1024) return;
    cacheFotos.set(chave, valor);
    cacheBytes += valor.buffer.length;
    while (cacheBytes > CACHE_MAX && cacheFotos.size > 0) {
        const [primeira, v] = cacheFotos.entries().next().value;
        cacheFotos.delete(primeira);
        cacheBytes -= v.buffer.length;
    }
}

function limparCacheDoProduto(id) {
    for (const [chave, v] of cacheFotos) {
        if (chave.startsWith(`${id}:`)) {
            cacheFotos.delete(chave);
            cacheBytes -= v.buffer.length;
        }
    }
}

// BUSCAR PRODUTOS (sem o base64 das fotos)
app.get('/api/produtos', async (req, res) => {
    try {
        await bancoPronto;
        const extras = [
            colunasExtras.categoria ? 'categoria' : 'NULL AS categoria',
            colunasExtras.selo ? 'selo' : 'NULL AS selo'
        ].join(', ');
        const sql = `
            SELECT id, name, descricao, available_types, variations, ordem, ${extras},
                   CASE WHEN json_typeof(${IMAGES_JSON}) = 'array'
                        THEN json_array_length(${IMAGES_JSON}) ELSE 0 END AS qtd_imagens,
                   md5(COALESCE(images::text, '')) AS versao
            FROM produtos
            ORDER BY ordem ASC, id DESC`;
        const result = await pool.query(sql);
        const base = urlBase(req);

        // Cores e variações antigas guardam a foto inteira (base64) no campo "image".
        // Troca por "imageIndex" (posição da foto), comparando só a assinatura md5,
        // para não mandar o base64 de novo para a vitrine.
        const precisaMapear = new Set();
        const linhas = result.rows.map(p => {
            const types = parseMaybeJson(p.available_types, []);
            const vars = parseMaybeJson(p.variations, []);
            const temBase64 = [types, vars].some(lista =>
                Array.isArray(lista) && lista.some(x => x && typeof x.image === 'string' && x.image.startsWith('data:')));
            if (temBase64) precisaMapear.add(p.id);
            return { p, types, vars };
        });
        const indicePorMd5 = new Map();
        if (precisaMapear.size > 0) {
            const r = await pool.query(
                `SELECT p.id, t.ord - 1 AS idx, md5(t.elem) AS assinatura
                 FROM produtos p, json_array_elements_text(${IMAGES_JSON}) WITH ORDINALITY AS t(elem, ord)
                 WHERE p.id = ANY($1::int[]) AND json_typeof(${IMAGES_JSON}) = 'array'`,
                [[...precisaMapear]]
            );
            for (const x of r.rows) indicePorMd5.set(`${x.id}:${x.assinatura}`, Number(x.idx));
        }
        const crypto = require('crypto');
        const trocarImagem = (id, lista) => Array.isArray(lista) ? lista.map(x => {
            if (!x || typeof x.image !== 'string' || !x.image.startsWith('data:')) return x;
            const assinatura = crypto.createHash('md5').update(x.image).digest('hex');
            const { image, ...resto } = x;
            const idx = indicePorMd5.get(`${id}:${assinatura}`);
            return idx === undefined ? resto : { ...resto, imageIndex: idx };
        }) : lista;

        const formatados = linhas.map(({ p, types, vars }) => {
            let parsedVariations = trocarImagem(p.id, vars);
            if (!Array.isArray(parsedVariations) || parsedVariations.length === 0) {
                parsedVariations = [{ size: 'Varejo', price: 0 }, { size: 'Atacado', price: 0 }];
            }
            const versao = String(p.versao || '').slice(0, 10);
            const images = [];
            for (let i = 0; i < Number(p.qtd_imagens || 0); i++) {
                images.push(`${base}/api/produtos/${p.id}/imagem/${i}?v=${versao}`);
            }
            return {
                id: p.id,
                name: p.name,
                desc: p.descricao,
                images,
                availableTypes: trocarImagem(p.id, types),
                variations: parsedVariations,
                ordem: p.ordem || 0,
                categoria: p.categoria || '',
                selo: p.selo || ''
            };
        });
        res.set('Cache-Control', 'no-store');
        res.status(200).json(formatados);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erro ao buscar produtos." });
    }
});

// SERVIR UMA FOTO (com redução de tamanho opcional: ?w=600)
app.get('/api/produtos/:id/imagem/:idx', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(id) || !Number.isInteger(idx) || idx < 0) return res.sendStatus(400);

    let largura = parseInt(req.query.w, 10) || 0;
    largura = Math.min(Math.max(largura, 0), 2000);
    const versao = String(req.query.v || '');
    const chave = `${id}:${idx}:${largura}:${versao}`;
    const cacheControl = versao ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';

    try {
        let foto = cacheFotos.get(chave);
        if (!foto) {
            const r = await pool.query(
                `SELECT (${IMAGES_JSON}) ->> $2::int AS img FROM produtos WHERE id = $1`,
                [id, idx]
            );
            const img = r.rows[0] && r.rows[0].img;
            if (!img) return res.sendStatus(404);

            if (/^https?:\/\//i.test(img)) return res.redirect(img);

            const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(img);
            if (!m) return res.sendStatus(404);
            let tipo = m[1] || 'image/jpeg';
            let buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));

            if (sharp && largura > 0) {
                try {
                    buffer = await sharp(buffer)
                        .rotate()
                        .resize({ width: largura, withoutEnlargement: true })
                        .webp({ quality: 80 })
                        .toBuffer();
                    tipo = 'image/webp';
                } catch (e) {
                    console.warn('Falha ao reduzir foto, enviando original:', e.message);
                }
            }
            foto = { tipo, buffer };
            guardarNoCache(chave, foto);
        }
        res.set('Content-Type', foto.tipo);
        res.set('Cache-Control', cacheControl);
        res.send(foto.buffer);
    } catch (err) {
        console.error(err);
        res.sendStatus(500);
    }
});

// Converte links de fotos já salvas (/api/produtos/ID/imagem/N) de volta no conteúdo original
async function resolverImagens(lista) {
    const fotosPorProduto = new Map();
    const final = [];
    for (const item of lista) {
        if (typeof item !== 'string' || !item) continue;
        const m = /\/api\/produtos\/(\d+)\/imagem\/(\d+)/.exec(item);
        if (!m || item.startsWith('data:')) {
            final.push(item);
            continue;
        }
        const pid = Number(m[1]);
        const pidx = Number(m[2]);
        if (!fotosPorProduto.has(pid)) {
            const r = await pool.query("SELECT images FROM produtos WHERE id = $1", [pid]);
            fotosPorProduto.set(pid, r.rows[0] ? parseMaybeJson(r.rows[0].images, []) : []);
        }
        const original = fotosPorProduto.get(pid)[pidx];
        if (original) final.push(original);
    }
    return final;
}

// SALVAR OU ATUALIZAR
// Na atualização, campos que não forem enviados continuam como estão.
// Assim editar preço ou nome não mexe nas fotos.
app.post('/api/produtos', async (req, res) => {
    const { id, name, desc, images, availableTypes, variations, ordem, categoria, selo } = req.body;

    try {
        await bancoPronto;
        const imagensFinal = Array.isArray(images) ? await resolverImagens(images) : undefined;

        if (id) {
            const sets = [];
            const params = [];
            const set = (coluna, valor) => { params.push(valor); sets.push(`${coluna} = $${params.length}`); };

            if (name !== undefined) set('name', name);
            if (desc !== undefined) set('descricao', desc);
            if (availableTypes !== undefined) set('available_types', JSON.stringify(availableTypes || []));
            if (variations !== undefined) set('variations', JSON.stringify(variations || []));
            if (ordem !== undefined && ordem !== null) set('ordem', Number(ordem) || 0);
            if (imagensFinal !== undefined) set('images', JSON.stringify(imagensFinal));
            if (colunasExtras.categoria && categoria !== undefined) set('categoria', (categoria || '').trim() || null);
            if (colunasExtras.selo && selo !== undefined) set('selo', (selo || '').trim() || null);

            if (sets.length === 0) return res.status(200).json({ message: "Nada para alterar." });

            params.push(id);
            await pool.query(`UPDATE produtos SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
            if (imagensFinal !== undefined) limparCacheDoProduto(id);
            res.status(200).json({ message: "Alterações salvas!" });
        } else {
            const colunas = ['name', 'descricao', 'images', 'available_types', 'variations', 'ordem'];
            const valores = [
                name,
                desc,
                JSON.stringify(imagensFinal || []),
                JSON.stringify(availableTypes || []),
                JSON.stringify(variations || []),
                Number(ordem) || 0
            ];
            if (colunasExtras.categoria) { colunas.push('categoria'); valores.push((categoria || '').trim() || null); }
            if (colunasExtras.selo) { colunas.push('selo'); valores.push((selo || '').trim() || null); }
            const marcadores = valores.map((_, i) => `$${i + 1}`).join(', ');
            const r = await pool.query(
                `INSERT INTO produtos (${colunas.join(', ')}) VALUES (${marcadores}) RETURNING id`,
                valores
            );
            res.status(201).json({ message: "Novo produto adicionado!", id: r.rows[0].id });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erro ao salvar no banco." });
    }
});

// REORDENAR
app.post('/api/produtos/reordenar', async (req, res) => {
    const { listaOrdem } = req.body;
    if (!listaOrdem || !Array.isArray(listaOrdem)) return res.sendStatus(200);

    try {
        for (const item of listaOrdem) {
            await pool.query("UPDATE produtos SET ordem = $1 WHERE id = $2", [item.ordem, item.id]);
        }
        res.status(200).json({ message: "Ordem atualizada!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erro ao reordenar." });
    }
});

// DELETAR PRODUTO
app.delete('/api/produtos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM produtos WHERE id = $1", [id]);
        limparCacheDoProduto(id);
        res.status(200).json({ message: "Excluído!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erro ao deletar." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor online na porta ${PORT}`));

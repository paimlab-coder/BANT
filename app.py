# -*- coding: utf-8 -*-
"""PAIM IA PROSPECT - app.py VER50: Brasil (paim_engine) + America Latina (latam_engine), CORS e erros em JSON."""
from __future__ import annotations
import os
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path

from flask import Flask, Response, jsonify, make_response, request, stream_with_context

import paim_engine as engine
import latam_engine as latam
from werkzeug.exceptions import HTTPException

app = Flask(__name__)

# Origem exata do GitHub Pages. Pode ser sobrescrita no Render por CORS_ORIGINS.
ALLOWED_ORIGINS = {
    origin.strip().rstrip('/')
    for origin in os.environ.get(
        'CORS_ORIGINS',
        # 'null' = HTML aberto direto do computador (file://), usado nos testes locais.
        'https://paimlab-coder.github.io,null'
    ).split(',')
    if origin.strip()
}

# Render Free usa filesystem efemero. Arquivos temporarios/cache ficam em /tmp.
runtime = Path(tempfile.gettempdir()) / 'paim_prospect_runtime'
runtime.mkdir(parents=True, exist_ok=True)
engine.TARGET = runtime
engine.CACHE = runtime / 'cache_overture'
engine.MUNICIPIOS_CSV = runtime / 'municipios_brasil.csv'
engine.CITY.clear()

_startup_error = None
try:
    engine.load_municipalities()
except Exception as exc:
    _startup_error = f'{type(exc).__name__}: {exc}'


def cors_origin():
    origin = (request.headers.get('Origin') or '').rstrip('/')
    return origin if origin in ALLOWED_ORIGINS else None


@app.after_request
def add_cors_headers(response):
    origin = cors_origin()
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept'
        response.headers['Access-Control-Max-Age'] = '86400'
    return response


# Qualquer erro vira JSON (com CORS pelo after_request) em vez de "Failed to fetch" no navegador.
@app.errorhandler(Exception)
def handle_any_error(exc):
    code = exc.code if isinstance(exc, HTTPException) else 500
    if code >= 500:
        app.logger.exception('Erro nao tratado em %s', request.path)
    return jsonify({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}), code


# CNAE escolhido sem segmento: usa o segmento correspondente (o motor trabalha por segmento).
CNAE_TO_SEGMENT = {
    '5211-7/99': 'Depósitos de mercadorias para terceiros, exceto armazéns gerais e guarda-móveis',
    '5210-9/99': 'Depósitos de mercadorias para terceiros, exceto armazéns gerais e guarda-móveis',
    '5211-7/01': 'Operador logístico', '5210-9/01': 'Operador logístico',
    '5250-8/04': 'Operador logístico',
    '5211-7/02': 'Centro de distribuição', '5210-9/02': 'Centro de distribuição',
    '4930-2/02': 'Transportadora',
    '1099-6/99': 'Alimentos',
    '1113-5/02': 'Bebidas',
    '3101-2/00': 'Moveleira',
    '2121-1/01': 'Farmacêutica',
    '4790-3/02': 'E-commerce',
}


# Responde o preflight sem passar pela rotina pesada de prospeccao.
@app.route('/api/<path:any_path>', methods=['OPTIONS'])
def api_options(any_path):
    origin = cors_origin()
    if not origin:
        return jsonify({'ok': False, 'error': 'Origem CORS não autorizada.'}), 403
    return make_response('', 204)


@app.get('/')
def root():
    return jsonify({
        'ok': True,
        'service': 'PAIM IA PROSPECT API',
        'version': '51-news',
        'source': 'Overture Maps',
        'municipalities': len(engine.CITY),
        'latam_countries': sorted(latam.SUPPORTED),
        'startup_error': _startup_error,
        'allowed_origins': sorted(ALLOWED_ORIGINS),
    })


@app.get('/api/health')
def health():
    status = 200 if not _startup_error and len(engine.CITY) >= 5500 else 503
    return jsonify({
        'ok': status == 200,
        'version': '51-news',
        'source': 'Overture Maps',
        'municipalities': len(engine.CITY),
        'latam_countries': sorted(latam.SUPPORTED),
        'error': _startup_error,
    }), status


# ---------------------------------------------------------------------------
# Notícias recentes do mercado para o Benchmarking (Google Notícias via RSS).
# O navegador não consegue ler o RSS direto (bloqueio de CORS); o servidor lê,
# guarda em cache por 30 minutos e devolve em JSON. Só leitura, sem dados do usuário.
# ---------------------------------------------------------------------------
import time as _time
import urllib.parse as _uparse
import urllib.request as _ureq
import xml.etree.ElementTree as _ET
from email.utils import parsedate_to_datetime as _pdt

_NEWS_CACHE = {}
_NEWS_TTL = 30 * 60
_NEWS_LANG = {
    'pt': {'hl': 'pt-BR', 'gl': 'BR', 'ceid': 'BR:pt-419'},
    'en': {'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'},
    'es': {'hl': 'es-419', 'gl': 'MX', 'ceid': 'MX:es-419'},
}


def _fetch_news(query, lang, days):
    key = (query, lang, days)
    hit = _NEWS_CACHE.get(key)
    if hit and _time.time() - hit[0] < _NEWS_TTL:
        return hit[1]
    params = dict(_NEWS_LANG.get(lang, _NEWS_LANG['pt']))
    params['q'] = f'{query} when:{days}d'
    url = 'https://news.google.com/rss/search?' + _uparse.urlencode(params)
    req = _ureq.Request(url, headers={'User-Agent': 'Mozilla/5.0 (PAIM Radar BSA; benchmarking)'})
    with _ureq.urlopen(req, timeout=15) as r:
        root = _ET.fromstring(r.read())
    items = []
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        src_el = it.find('source')
        fonte = (src_el.text or '').strip() if src_el is not None else ''
        if fonte and title.endswith(' - ' + fonte):
            title = title[: -len(' - ' + fonte)]
        try:
            data = _pdt(it.findtext('pubDate') or '').date().isoformat()
        except Exception:
            data = ''
        items.append({'titulo': title, 'url': (it.findtext('link') or '').strip(), 'fonte': fonte, 'data': data})
        if len(items) >= 15:
            break
    _NEWS_CACHE[key] = (_time.time(), items)
    return items


@app.get('/api/news')
def news_api():
    queries = [q.strip() for q in request.args.getlist('q') if q.strip()][:12]
    lang = request.args.get('lang', 'pt')
    days = max(1, min(90, int(request.args.get('days', 30))))
    if not queries:
        return jsonify({'ok': False, 'error': 'Informe ao menos um parâmetro q.'}), 400
    out, erros = [], []
    for q in queries:
        try:
            for it in _fetch_news(q, lang, days):
                out.append(dict(it, consulta=q, idioma=lang))
        except Exception as exc:
            erros.append(f'{q}: {type(exc).__name__}')
    seen, uniq = set(), []
    for it in sorted(out, key=lambda x: x['data'], reverse=True):
        k = it['titulo'].lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(it)
    return jsonify({'ok': True, 'items': uniq, 'erros': erros, 'fetchedAt': _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime()), 'fonte': 'Google Notícias (RSS)'})


@app.route('/api/prospect', methods=['GET','POST'])
def prospect_api():
    payload = request.args.to_dict() if request.method == 'GET' else (request.get_json(silent=True) or {})
    iso = str(payload.get('country_iso', 'BR') or 'BR').strip().upper()
    if iso == 'BR' and _startup_error:
        return jsonify({'ok': False, 'error': _startup_error}), 503
    try:
        city = str(payload.get('city', '')).strip()
        region = str(payload.get('uf', '')).strip()
        uf = region.upper()
        segment = str(payload.get('segment', '')).strip()
        if not segment:
            segment = CNAE_TO_SEGMENT.get(str(payload.get('cnae', '')).strip(), '')
        segment_es = str(payload.get('segment_es', '')).strip()
        km = max(5, min(250, int(payload.get('km', 20))))
        limit = max(1, min(1500, int(payload.get('limit', 50))))
        min_score = max(0, min(100, int(payload.get('min_score', 0))))

        if not city or not uf or not segment:
            return jsonify({
                'ok': False,
                'error': 'Estado/província, cidade e segmento (ou CNAE) são obrigatórios.'
            }), 400

        if iso == 'BR':
            task = (engine.prospect, (city, uf, segment, km, limit, min_score))
        elif iso in latam.SUPPORTED:
            task = (latam.prospect, (iso, region, city, segment, segment_es, km, limit, min_score))
        else:
            return jsonify({'ok': False, 'error': f'País não suportado: {iso}.'}), 400

        def generate():
            # Mantém a conexão HTTP ativa durante a busca por blocos.
            # Espaços antes do JSON são válidos e evitam inatividade prolongada.
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(task[0], *task[1])
                yield '\n'
                while True:
                    try:
                        data = future.result(timeout=15)
                        data['requested_km'] = km
                        yield json.dumps(data, ensure_ascii=False)
                        break
                    except FutureTimeoutError:
                        yield ' '
                    except Exception as exc:
                        yield json.dumps({
                            'ok': False,
                            'error': f'{type(exc).__name__}: {exc}'
                        }, ensure_ascii=False)
                        break

        return Response(
            stream_with_context(generate()),
            mimetype='application/json; charset=utf-8',
            headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'}
        )
    except Exception as exc:
        return jsonify({
            'ok': False,
            'error': f'{type(exc).__name__}: {exc}'
        }), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '10000'))
    app.run(host='0.0.0.0', port=port)

import { api, common, config, extension } from "@nfjs/core";
import fs from "fs";
import zlib from "zlib";
import mime from "mime";
import { web } from "@nfjs/back";
import { MultiStream } from "./multistream.js";
import path from "path";
import LRUCache from "lru-cache";
import * as Stream from "stream";
import { minify } from "terser";
import { minifyHTMLLiterals, defaultMinifyOptions } from 'minify-html-literals';
import crypto from 'crypto';
/**
 *
 * @type {Object} FrontServerConfig
 * @property {Object} [modules]
 * @property {String} [modules.es5route]
 * @property {String} [modules.cache_maxage]
 * @property {String} [modules.serverCache]
 *
 */
const moduleConfig = common.getPath(config, '@nfjs/front-server') || {};
moduleConfig.modules = moduleConfig.modules || {};


const cacheOptions = {
    max: moduleConfig.modules.cacheMaxSize || 100_000_000, // default 100Mb
    maxAge: 1000 * 60 * 60 * 24, // default 1 day
    length: (n, key) => n.body?.length
};
const cache = new LRUCache(cacheOptions);

let cacheHashes = {};
let customElements = [];
let themes = [];
function replacer(options) {
    return (m, s, f, e) => {
        let match = f.match(/^\/?([@\w][\w.-]*)(\/.*)?/);
        let route = match && api.getRouteMap(match[1]);
        if (options && options.cacheKeyExtension > 0 && route.options && route.options.es5route)
            f = route.options.es5route + (match?.[2] || '');
        if (route && route.options && route.options.replace) {
            f = route.options.replace
        } else {
            // временный костыль для серверных библиотек, используемых на клиенте
            try {
                if (match && match[1] && match[2]) {
                    try {
                        let pj = JSON.parse(fs.readFileSync(process.cwd() + '/node_modules/' + f + '/package.json', 'utf8'));
                        let file = /*(options && options.cacheKeyExtension == 0) &&*/ (pj.module || pj['jsnext:main']) || pj.main || match[1];
                        f += '/' + file;
                    } catch (e) {
                    }
                }
                if (match && match[1] && !match[2]) {
                    // указано только имя библиотеки, выясняем что нужно загружать
                    let pj = JSON.parse(fs.readFileSync(process.cwd() + '/node_modules/' + match[1] + '/package.json', 'utf8'));
                    let file = /*(options && options.cacheKeyExtension == 0) &&*/ (pj.module || pj['jsnext:main']) || pj.main || match[1];
                    f += '/' + file;
                }
                match = f.match(/(\/nf-.*|\.[^.\/]+)$/);
                if (!match) {
                    f += '.js';
                }
            } catch (err) {
                console.log(err);
            }

        }
        if (/*route &&*/ f[0] !== '.' && f[0] !== '/') {
            return [s, '/', f, e].join('');
        } else {
            return [s, f, e].join('');
        }

    };
}


/**
 *
 * @param stream
 * @return {Promise<String>}
 */
function streamToBuffer(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    })
}

function replacePaths(body, options) {
    return body.replace(/((?:\bimport\b|\bexport\b)[\w *{}\n,$]*?['"])([^ ]*?)(['"]\s*;?)/gm, replacer(options));
}

/**
 *
 * @param cacheKey
 * @param {Object} options
 * @param {Boolean} [options.denyPathReplace]
 * @param {String} [options.mimeType]
 * @param {Object} [options.customOptions]
 * @param {String} [options.contentType]
 * @param {String} [options.minify]
 * @param cb
 * @return {Promise<{notfound: boolean}|{headers: {"Cache-Control": string, "Last-Modified": string, Expires: string|undefined, "Content-Type": string|string|*}, stream: (*|Chai.Assertion|string|ReadStream)}|{headers: {"Content-Type": (string|string|*)}, stream: *}|{headers: {"Content-Type": (string|string|*)}, stream: (TransformStream|*)}>}
 */
async function prepareResponse(cacheKey, options, cb) {
    if (!options) options = {};
    if (moduleConfig.modules.serverCache) {
        if (!cache.has(cacheKey)) {
            let metadata = {
                headers: {
                    'Cache-Control': `public, max-age=${moduleConfig.modules.cache_maxage || 0}`,
                    'Last-Modified': (new Date()).toUTCString(),
                    'Expires': moduleConfig.modules.cache_maxage ? (new Date(new Date().getTime() + moduleConfig.modules.cache_maxage * 1000)).toUTCString() : undefined,
                    'Content-Type': options.mimeType
                }
            };
            const cbStream = await cb();
            if (!cbStream) {
                metadata['notfound'] = true;
                cache.set(cacheKey, { metadata })
                return { notfound: true };
            }

            let body = (cbStream instanceof Stream.Readable) ? await streamToBuffer(cbStream) : cbStream;
            if (['text/html', 'application/javascript', 'text/css', 'image/svg+xml', 'text/javascript'].includes(options.mimeType)) {
                body = Buffer.isBuffer(body) ? body.toString() : body;
            }
            const customOptions = options.customOptions;



            if (options.mimeType === 'application/javascript') {
                // добавляем замену путей для js импортов, если не запрещено
                if (!options.denyPathReplace)
                    body = replacePaths(body, options);

                metadata.headers['Content-Type'] = 'application/javascript';
                //TODO: hooks for compat
                /*if (customOptions && customOptions.cacheKeyExtension > 0)
                    frontHooks.modulePreProcessors.forEach(p => {
                        streamsForPipeline.push(p(customOptions));
                    });*/
            }
            if (options.mimeType === 'text/html') {
                // добавляем замену путей для js импортов, если не запрещено
                if (!options.denyPathReplace)
                    body = replacePaths(body, options);

                metadata.headers['Content-Type'] = 'text/html';
                //TODO: hooks for compat
                /*if (customOptions && customOptions.cacheKeyExtension > 0)
                    frontHooks.htmlPreProcessors.forEach((p) => {
                        streamsForPipeline.push(p(customOptions));
                    });*/
            }
            // добавляем минификацию если нужно и разрешено
            if (moduleConfig.modules.minify &&
                options.minify !== 'deny' &&
                (options.mimeType === 'application/javascript' || options.mimeType === 'text/javascript')
            ) {
                let minifiedTemplate = await minifyHTMLLiterals(body, {
                    minifyOptions: {
                        ...defaultMinifyOptions
                    }
                });
                body = (await minify(minifiedTemplate?.code || body)).code
            };
            // добавляем сжатие если требуется
            if (moduleConfig.modules.gzip && ['text/html', 'application/javascript', 'text/css', 'image/svg+xml'].includes(options.mimeType)) {
                Object.assign(metadata.headers, { 'Content-Encoding': 'gzip' });
                body = zlib.gzipSync(body);
            }


            // запускаем подсчет хеша от результата, для установки e-tag
            let hash = crypto.createHash('sha1');
            hash.update(body);
            Object.assign(metadata.headers, {
                'etag': `W/"${hash.digest('hex')}"`,
                'Last-Modified': (new Date()).toUTCString()
            });


            // пишем все в кеш
            cache.set(cacheKey, { metadata, body });

            return { stream: body, headers: metadata.headers };
        } else {

        }
        const { metadata, body } = cache.get(cacheKey);
        if (metadata.notfound) {
            return { notfound: true };
        } else {
            return { stream: body, headers: metadata.headers };
        }
    } else {

        const c = await cb();
        if (c) {
            const headers = { 'Content-Type': options.mimeType };
            if (0 || options.mimeType === 'application/javascript' || options.mimeType === 'text/javascript' || options.mimeType === 'text/html') {
                let stream = (c instanceof Stream.Readable) ? await streamToBuffer(c) : c;
                stream = Buffer.isBuffer(stream) ? stream.toString() : stream;
                if (!options.denyPathReplace)
                    stream = replacePaths(stream, options)
                return { stream, headers };
            } else {
                return { stream: c, headers };
            }
        } else {
            return { notfound: true };
        }
    }
}

function getCacheKey(path, customOptions) {
    return path + (customOptions && customOptions.cacheKeyExtension ? `#${customOptions.cacheKeyExtension}` : '');
}

function sanitizePath(base, userpath) {
    let fixedPath = '.' + path.normalize('/' + userpath)
    return path.resolve(base, fixedPath);
}

/**
 *
 * @param {String} lib - route до библиотеки
 * @param {String} [path] - реальный путь до директории с файлами, если отличается
 * @param {Object} [options] - дополнительные опции:
 * @param {String} [options.minify] -  ==deny - запрет минификации для скриптов
 * @param {Boolean} [options.singleFile] - абсолютный путь до библиотеки
 * @param {Boolean} [options.denyPathReplace]
 * @param {Boolean} [options.allowPackageJson]
 */
function registerLibDir(lib, path, options) {
    if (!path) { path = process.cwd() + '/node_modules/' + lib };
    web.on('GET', `/${lib}${options?.singleFile ? '' : '/*'}`, options || {}, async context => {
        let userPath = context.params['*'] || '';
        if (userPath.toLowerCase() === 'package.json' && !(options?.allowPackageJson ?? false))
            context.code(404).end();
        let req_path = sanitizePath('/' + context.store.lib, userPath);
        let filepath = sanitizePath(context.store.path, userPath);
        const mimeType = mime.getType(filepath);
        const cacheKey = getCacheKey(req_path, context.customOptions);
        const response = await prepareResponse(
            cacheKey,
            Object.assign({}, options, { customOptions: context.customOptions, mimeType }),
            async () => {
                if (context.store.additionalStylePath) {
                    let theme = await streamToBuffer(fs.createReadStream(context.store.additionalStylePath));
                    
                    let patch = `customElements.whenDefined(\`${context.store.customElementName}\`).then(() => {
                        const stylesheet = new CSSStyleSheet();
                        stylesheet.replaceSync(\`${theme.toString()}\`);
                        for(let rule of stylesheet.cssRules) {
                            customElements.get(\`${context.store.customElementName}\`).prototype.constructor.css.insertRule(rule.cssText,customElements.get(\`${context.store.customElementName}\`).prototype.constructor.css.cssRules.length);
                        }
                    });`

                    var s = new Stream.Readable();
                    s.push(patch);
                    s.push(null);

                    return new MultiStream([fs.createReadStream(filepath), s]);
                } else {
                    const stream = fs.createReadStream(filepath);
                    stream.on('error', (e) => {
                        context.code(404);
                        context.end();
                    });
                    return stream;
                }
            }
        );
        if (response.headers) context.headers(response.headers);

        if (response.stream) context.send(response.stream);
    }, { path, lib, ...options })
}

async function registerCustomElementsDir(lib, path, options) {
    if (!path) { path = process.cwd() + '/node_modules/' + lib };

    if (options?.recursive) {
        let dirs = fs.readdirSync(path);
        dirs.forEach((dir) => {
            registerCustomElementsDir(lib + '/' + dir);
        })
    } else {
        try {
            let files = fs.readdirSync(path).filter(x => x.endsWith('.js'));

            for (let el of files) {
                let req_path = `${lib}/${el}`;
                const idx = customElements.findIndex(x => x.name == el.replace('.js', ''));
                if (idx > -1) {
                    customElements[idx].path = req_path;
                } else {
                    customElements.push({ name: el.replace('.js', ''), path: req_path });
                }

                let themeStylePath = await extension.getFiles(`/theme/${config.theme}/${el.replace('.js', '.css')}`);
                let opts = Object.assign({}, options, {
                    override: true,
                    singleFile: true,
                    customElementName: el.replace('.js', ''), 
                    additionalStylePath: themeStylePath
                })
                registerLibDir(req_path, null, opts);
            }
        }
        catch (err) {
            console.error(err);
        }
    }
};

async function cmpInitHandler(context) {
    const path = '/@front/init';
    let customOptions = context.customOptions;
    let cacheKey = getCacheKey(path, customOptions);
    if (context.req.headers['If-None-Match'] === `W/"${cacheHashes[cacheKey]}"`) {
        context.code(304);
        context.end();
        return;
    }
    const response = await prepareResponse(cacheKey,
        { customOptions, contentType: 'javascript', mimeType: 'application/javascript' },
        async () => {
            let initfiles = [extension.getFiles('components/init.js', { resArray: true })];
            let files = await Promise.all(initfiles);
            files = files.reduce((a, i) => { a.push(...i); return a; }, []);
            return new MultiStream(files.map(file => fs.createReadStream(file)));
        });
    context.headers(response.headers);
    context.send(response.stream);
}
web.on('GET', '/@front/init.js', cmpInitHandler);

export { replacer, getCacheKey, prepareResponse, registerLibDir, registerCustomElementsDir, customElements }
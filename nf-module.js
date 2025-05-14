import { web } from '@nfjs/back';
import { addClientURLCacheString, getCacheKey, prepareResponse } from './lib/server.js';
import fs from 'fs';
import { PassThrough } from 'stream';
import { MultiStream } from './lib/multistream.js';

import { extension, config } from '@nfjs/core';
import mime from 'mime';

const staticPathsMap = new Map();

async function init() {
    web.on('GET', '/', {}, async (context) => {
        const requestPath = await extension.getFiles('static/_index.html');
        const customOptions = context.customOptions;
        const cacheKey = getCacheKey(requestPath, customOptions);
        const response = await prepareResponse(cacheKey,
            { customOptions, contentType: 'html', mimeType: 'text/html', addClientURLCacheString, noCache: true },
            () => {
                return fs.createReadStream(requestPath);
            });
        context.headers(response.headers);
        context.send(response.stream);
    });

    web.on('GET', '/static/*', { }, async (context) => {
        let requestPath = null;
        if (staticPathsMap.get(context.params['*'])) {
            requestPath = staticPathsMap.get(context.params['*']);
        } else {
            requestPath = await extension.getFiles('static/' + context.params['*']);
            staticPathsMap.set(context.params['*'], requestPath);
        }
        if (!requestPath) {
            context.code(404);
            context.end();
            return;
        }
        const customOptions = context.customOptions;
        const cacheKey = getCacheKey(requestPath, customOptions);
        const response = await prepareResponse(cacheKey,
            { customOptions, mimeType: mime.getType(requestPath) },
            () => {
                return fs.createReadStream(requestPath);
            });
        if (context.req.headers['if-none-match'] && context.req.headers['if-none-match'] === response.headers.etag) {
            context.code(304);
            context.end();
        } else {
            context.headers(response.headers);
            context.send(response.stream);
        }
    });

    web.on('GET', '/nfjs-theme/', async (context) => {
        const theme = (context.params.theme || config.theme || 'default').split(',');
        const customOptions = context.customOptions;
        const cacheKey = getCacheKey('nfjs-theme/' + theme, customOptions);
        const response = await prepareResponse(cacheKey,
            { customOptions, minify: 'deny', contentType: 'css', mimeType: 'text/css' }, async () => {
                const streams = [];
                for (let i = 0, c = theme.length; i < c; i++) {
                    const styleFile = await extension.getFiles(`themes/${theme[i]}/style.css`, { invert: true });
                    if (styleFile) {
                        const st = new PassThrough();
                        st.write(`\n/*nfjs-theme-${theme[i]}*/\n`);
                        st.end();
                        streams.push(st);
                        streams.push(fs.createReadStream(styleFile));
                    }
                }
                const stream = new PassThrough();
                const mstream = new MultiStream(streams);
                mstream.pipe(stream);
                return stream;
            });

        context.headers(response.headers);
        context.send(response.stream);
    });
}

export {
    init
};

import { web } from "@nfjs/back";
import { getCacheKey, prepareResponse } from "./lib/server.js";
import fs from "fs";

import { extension } from "@nfjs/core";
import mime from "mime";

let staticPathsMap = new Map();


async function init() {

    web.on('GET', '/', {}, async context => {
        const requestPath = await extension.getFiles('static/_index.html');
        const customOptions = context.customOptions;
        const cacheKey = getCacheKey(requestPath, customOptions);
        const response = await prepareResponse(cacheKey,
            { customOptions, contentType: 'html', mimeType: 'text/html' },
            () => {
                return fs.createReadStream(requestPath);
            });
        context.headers(response.headers);
        context.send(response.stream);
    });

    web.on('GET', '/static/*', { }, async context => {
        let requestPath = null;
        if(staticPathsMap.get(context.params['*'])) {
            requestPath = staticPathsMap.get(context.params['*']);
        } else {
            requestPath = await extension.getFiles('static/' + context.params['*']);
            staticPathsMap.set(context.params['*'], requestPath);
        }
        const customOptions = context.customOptions;
        const cacheKey = getCacheKey(requestPath, customOptions);
        const response = await prepareResponse(cacheKey,
            { customOptions, mimeType: mime.getType(requestPath) },
            () => {
                return fs.createReadStream(requestPath);
            });
        context.headers(response.headers);
        context.send(response.stream);
    });
}

export {
    init
};
import { web } from "@nfjs/back";
import { getCacheKey, prepareResponse, registerLibDir } from "./lib/server.js";
import fs from "fs";

import { extension } from "@nfjs/core";
import path from 'path';
const __dirname = path.join(path.dirname(decodeURI(new URL(import.meta.url).pathname))).replace(/^\\([A-Z]:\\)/, "$1");

async function init() {
    registerLibDir('front', __dirname + '/static');

    web.on('GET', '/', {}, async context => {
        //context.type('text/html');
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
}

export {
    init
};
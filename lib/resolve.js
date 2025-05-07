import fs from 'fs';
import path from 'node:path';

const cwd = process.cwd();

export function resolve(url, options = {}) {
    const { packageName, urlPath } = url.match(/^(?<packageName>(?:@\w[\w.-]*\/)?\w[\w.-]*\/?)?(?<urlPath>(?:(?:\.\.|\.)\/)?.*)?/).groups ?? {};
    let result, file;
    if (packageName) {
        try {
            const packageJsonFilename = path.resolve(cwd, 'node_modules', packageName, 'package.json');
            const packageJSON = JSON.parse(fs.readFileSync(packageJsonFilename, 'utf8'));
            file = urlPath || packageJSON.module || packageJSON['jsnext:main'] || packageJSON.main;
            result = path.join('/', packageName, file);
        } catch {
            result = urlPath;
        }
    } else {
        if (urlPath[0] !== '.' && urlPath[0] !== '/') {
            result = '/' + urlPath;
        } else {
            result = urlPath;
        }
    }

    if (!/(\/nf-.*|\.[^./]+)$/.test(result)) {
        result += '.js';
    }

    if (options.addClientURLCacheString) result = options.addClientURLCacheString(result);

    return result;
}

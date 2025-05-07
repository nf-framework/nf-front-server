const frontHooks = {
    modulePreProcessors: [],
    htmlPreProcessors: []
};

export { frontHooks };
export { prepareResponse, getCacheKey, registerLibDir, registerCustomElementsDir, customElements, addClientURLCacheString } from './lib/server.js';
export { MultiStream } from './lib/multistream.js';

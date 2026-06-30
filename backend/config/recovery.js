// last resort for truncated config.json (e.g. killed mid-write)
function tryHealJson(str) {
    let jsonStr = str.trim();
    if (!jsonStr) return null;
    
    if (!jsonStr.startsWith('{')) return null;
    
    if (jsonStr.endsWith(',')) {
        jsonStr = jsonStr.slice(0, -1);
    }
    
    let openBraces = 0;
    let inQuote = false;
    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i];
        if (char === '"' && jsonStr[i - 1] !== '\\') {
            inQuote = !inQuote;
        }
        if (!inQuote) {
            if (char === '{') openBraces++;
            if (char === '}') openBraces--;
        }
    }
    
    while (openBraces > 0) {
        jsonStr += '}';
        openBraces--;
    }
    
    try {
        return JSON.parse(jsonStr);
    } catch (_) {
        return null;
    }
}

function extractKeysFromCorruptJson(str) {
    const extracted = {};
    
    const playerMatch = str.match(/"preferredPlayer"\s*:\s*"([^"]*)"/);
    if (playerMatch) extracted.preferredPlayer = playerMatch[1];
    
    const dirMatch = str.match(/"downloadDir"\s*:\s*"([^"]*)"/);
    if (dirMatch) {
        extracted.downloadDir = dirMatch[1].replace(/\\(.)/g, '$1');
    }
    
    const cookiesMatch = str.match(/"youtubeCookiesBrowser"\s*:\s*"([^"]*)"/);
    if (cookiesMatch) extracted.youtubeCookiesBrowser = cookiesMatch[1];
    
    return extracted;
}

module.exports = {
    tryHealJson,
    extractKeysFromCorruptJson
};

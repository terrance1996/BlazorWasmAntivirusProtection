var usedCacheKeys = {};
var cacheIfUsed;

export async function beforeStart(wasmOptions, extensions) {
    if (!extensions || !extensions.avpsettings) {
        return;
    }

    try {
        const settingsResponse = await fetch('avp-settings.json', { cache: 'no-cache' });
        var settings = await settingsResponse.json();
        cacheIfUsed = await getCacheToUseIfEnabled(settings);
        //This is to support custom Blazor.start with a custom loadBootResource 
        var existingLoadBootResouce = wasmOptions.loadBootResource;

        wasmOptions.loadBootResource = function (type, name, defaultUri, integrity) {
            if (type == "dotnetjs") {
                if (existingLoadBootResouce) {
                    return existingLoadBootResouce(type, name, defaultUri, integrity);
                }
                else {
                    return defaultUri;
                }
            }

            return getCachedResource(defaultUri, integrity).then(async cachedResponse => {
                if (cachedResponse) {
                    return unobfuscateResponse(cachedResponse, settings, type, name);
                }

                let response = null;
                if (existingLoadBootResouce) {
                    let existingLoaderResponse = existingLoadBootResouce(type, name, defaultUri, integrity);
                    if (typeof existingLoaderResponse == "string") {
                        response = await fetchAndSaveToCache(existingLoaderResponse, integrity, settings);
                    }
                    else {
                        response = await saveExternalResponseToCache(existingLoaderResponse, defaultUri, integrity);
                    }
                }
                else {
                    response = await fetchAndSaveToCache(defaultUri, integrity, settings);
                }

                return unobfuscateResponse(response, settings, type, name);

            });

        }
    } catch (error) {
        console.error(error);
    }
}


export async function afterStarted(blazor) {
    purgeUnusedCacheEntriesAsync();
}

async function unobfuscateResponse(response, settings, type, name) {
    var buffer = await response.arrayBuffer();

    var data = new Uint8Array(buffer);
    if (type == "assembly") {
        if (settings.obfuscationMode == 1) {//Changed Headers
            console.debug("Restoring binary header: " + name);
            data[0] = 77; //This restores header from BZ to MZ
        }
        else if (settings.obfuscationMode == 2) { //Xored dll
            console.debug("Restoring binary file Xor: " + name);
            var key = settings.xorKey;
            for (let i = 0; i < data.length; i++)
                data[i] = data[i] ^ key.charCodeAt(i % key.length); //This reverses the Xor'ing of the dll
        }
    }
    var newResponse = new Response(data, { "status": 200, headers: response.headers });
    return newResponse;
}

function getCacheKey(url, contentHash) {
    return toAbsoluteUri(`${url}.${contentHash}`);
}

async function getCachedResource(url, contentHash) {

    const cacheKey = getCacheKey(url, contentHash);
    let cachedResponse;
    try {
        if (cacheIfUsed) {
            usedCacheKeys[cacheKey] = true;
            cachedResponse = await cacheIfUsed.match(cacheKey);
        }
    } catch {
        // Be tolerant to errors reading from the cache. This is a guard for https://bugs.chromium.org/p/chromium/issues/detail?id=968444 where
        // chromium browsers may sometimes throw when working with the cache.
    }

    return cachedResponse;
}

async function saveExternalResponseToCache(fetchPromise, url, contentHash) {
    if (cacheIfUsed) {
        const cacheKey = getCacheKey(url, contentHash);
        //usedCacheKeys[cacheKey] = true;
        const networkResponse = await fetchPromise;
        addToCacheAsync(cacheIfUsed, cacheKey, networkResponse);
        return networkResponse;
    }
    else {
        //Do nothing
        return fetchPromise;
    }
}


async function fetchAndSaveToCache(url, contentHash, settings) {
    const response = cacheIfUsed
        ? loadResourceWithCaching(cacheIfUsed, url, contentHash, settings)
        : loadResourceWithoutCaching(url, contentHash, settings);

    return response;
}

// DISCLAIMER:
// ======================
// Most of the code below is copied from https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/WebAssemblyResourceLoader.ts
// Blazor's default caching is disabled and a custom caching of obfuscated dlls is being used. 
// This is because by default blazor caches the unobfuscated dlls and some antiviruses flag the cached files that are being stored on the disk by the browser.
// ======================

const networkFetchCacheMode = 'no-cache';
let testAnchor;
function toAbsoluteUri(relativeUri) {
    testAnchor = testAnchor || document.createElement('a');
    testAnchor.href = relativeUri;
    return testAnchor.href;
}

async function loadResourceWithCaching(cache, url, contentHash, settings) {
    // Since we are going to cache the response, we require there to be a content hash for integrity
    // checking. We don't want to cache bad responses. There should always be a hash, because the build
    // process generates this data.
    if (!contentHash || contentHash.length === 0) {
        throw new Error('Content hash is required');
    }

    const cacheKey = getCacheKey(url, contentHash);
    //usedCacheKeys[cacheKey] = true;

    //let cachedResponse;
    //try {
    //    cachedResponse = await cache.match(cacheKey);
    //} catch {
    //    // Be tolerant to errors reading from the cache. This is a guard for https://bugs.chromium.org/p/chromium/issues/detail?id=968444 where
    //    // chromium browsers may sometimes throw when working with the cache.
    //}

    //if (cachedResponse) {
    //    // It's in the cache.

    //    //const responseBytes = parseInt(cachedResponse.headers.get('content-length') || '0');
    //    //cacheLoads[name] = { responseBytes };
    //    return cachedResponse;
    //} else {
    // It's not in the cache. Fetch from network.
    const networkResponse = await loadResourceWithoutCaching(url, contentHash, settings);
    addToCacheAsync(cache, cacheKey, networkResponse);
    return networkResponse;
}

async function addToCacheAsync(cache, cacheKey, response) {
    // We have to clone in order to put this in the cache *and* not prevent other code from
    // reading the original response stream.
    const responseData = await response.clone().arrayBuffer();

    // Add to cache as a custom response object so we can track extra data such as responseBytes
    // We can't rely on the server sending content-length (ASP.NET Core doesn't by default)
    const responseToCache = new Response(responseData, {
        headers: {
            'content-type': response.headers.get('content-type') || '',
            'content-length': (response.headers.get('content-length') || '').toString(),
        },
    });

    try {
        await cache.put(cacheKey, responseToCache);
    } catch {
        // Be tolerant to errors writing to the cache. This is a guard for https://bugs.chromium.org/p/chromium/issues/detail?id=968444 where
        // chromium browsers may sometimes throw when performing cache operations.
    }
}

async function loadResourceWithoutCaching(url, contentHash, settings) {
    return fetch(url, {
        cache: networkFetchCacheMode,
        integrity: settings.cacheBootResources ? contentHash : undefined,
    });
}

async function getCacheToUseIfEnabled(settings) {
    // caches will be undefined if we're running on an insecure origin (secure means https or localhost)
    if (!settings.cacheBootResourcesObfuscated || typeof caches === 'undefined') {
        return null;
    }

    // cache integrity is compromised if the first request has been served over http (except localhost)
    // in this case, we want to disable caching and integrity validation
    if (window.isSecureContext === false) {
        return null;
    }

    // Define a separate cache for each base href, so we're isolated from any other
    // Blazor application running on the same origin. We need this so that we're free
    // to purge from the cache anything we're not using and don't let it keep growing,
    // since we don't want to be worst offenders for space usage.
    const relativeBaseHref = document.baseURI.substring(document.location.origin.length);
    const cacheName = `blazor-resources-${relativeBaseHref}`;

    try {
        // There's a Chromium bug we need to be aware of here: the CacheStorage APIs say that when
        // caches.open(name) returns a promise that succeeds, the value is meant to be a Cache instance.
        // However, if the browser was launched with a --user-data-dir param that's "too long" in some sense,
        // then even through the promise resolves as success, the value given is `undefined`.
        // See https://stackoverflow.com/a/46626574 and https://bugs.chromium.org/p/chromium/issues/detail?id=1054541
        // If we see this happening, return "null" to mean "proceed without caching".
        return (await caches.open(cacheName)) || null;
    } catch {
        // There's no known scenario where we should get an exception here, but considering the
        // Chromium bug above, let's tolerate it and treat as "proceed without caching".
        return null;
    }
}

async function purgeUnusedCacheEntriesAsync() {
    // We want to keep the cache small because, even though the browser will evict entries if it
    // gets too big, we don't want to be considered problematic by the end user viewing storage stats
    const cache = cacheIfUsed;
    if (cache) {
        const cachedRequests = await cache.keys();
        const deletionPromises = cachedRequests.map(async cachedRequest => {
            if (!(cachedRequest.url in usedCacheKeys)) {
                await cache.delete(cachedRequest);
            }
        });

        await Promise.all(deletionPromises);
    }
}
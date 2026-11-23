#import <Foundation/Foundation.h>
#include <stddef.h>
#include <stdlib.h>

// Node's stable C ABI keeps this bridge independent of V8 and additional packages.
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_get_value_string_utf8(napi_env, napi_value, char *, size_t, size_t *);
extern int napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern int napi_throw_error(napi_env, const char *, const char *);

static NSMutableDictionary<NSString *, NSURL *> *activeURLs;

static napi_value fail(napi_env env) {
    napi_throw_error(env, "invalid_sandbox_bookmarks", "Invalid directory access bookmarks");
    return NULL;
}
static napi_value resolveBookmarks(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        size_t count = 1, length = 0;
        napi_value arg;
        if (napi_get_cb_info(env, info, &count, &arg, NULL, NULL) || count != 1 ||
            napi_get_value_string_utf8(env, arg, NULL, 0, &length) || length > 1024 * 1024) return fail(env);
        char *buffer = malloc(length + 1);
        if (!buffer) return fail(env);
        if (napi_get_value_string_utf8(env, arg, buffer, length + 1, &length)) { free(buffer); return fail(env); }
        NSData *bytes = [NSData dataWithBytes:buffer length:length];
        free(buffer);
        NSDictionary *bookmarks = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
        if (![bookmarks isKindOfClass:[NSDictionary class]] || bookmarks.count > 64) return fail(env);
        NSMutableDictionary *next = [NSMutableDictionary new];
        NSMutableArray *paths = [NSMutableArray new];
        for (id path in bookmarks) {
            id value = bookmarks[path];
            if (![path isKindOfClass:[NSString class]] || ![path isAbsolutePath] || [path length] > 4096 ||
                ![value isKindOfClass:[NSString class]] || [value length] > 262144) return fail(env);
            NSData *data = [[NSData alloc] initWithBase64EncodedString:value options:0];
            if (!data) continue;
            NSURL *url = [NSURL URLByResolvingBookmarkData:data options:NSURLBookmarkResolutionWithoutUI | NSURLBookmarkResolutionWithoutMounting relativeToURL:nil bookmarkDataIsStale:NULL error:nil];
            if (url && [url.path isEqualToString:path]) { next[path] = url; [paths addObject:path]; }
        }
        // Implicit security scopes belong to the resolved NSURLs and end when the URLs are released.
        activeURLs = next;
        NSData *result = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
        napi_value output;
        if (!result || napi_create_string_utf8(env, result.bytes, result.length, &output)) return fail(env);
        return output;
    }
}
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value method;
    if (napi_create_function(env, "resolveBookmarks", 16, resolveBookmarks, NULL, &method) ||
        napi_set_named_property(env, exports, "resolveBookmarks", method)) return fail(env);
    return exports;
}

#import <Foundation/Foundation.h>
#include <stdio.h>
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 1;
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
        NSData *data = [url bookmarkDataWithOptions:0 includingResourceValuesForKeys:nil relativeToURL:nil error:nil];
        if (!data) return 2;
        puts([data base64EncodedStringWithOptions:0].UTF8String);
    }
    return 0;
}

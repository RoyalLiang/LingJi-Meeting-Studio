#import <Foundation/Foundation.h>
#include <unistd.h>
static void emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSBundle *bundle = NSBundle.mainBundle;
    NSString *home = NSHomeDirectory();
    NSString *bundleId = bundle.bundleIdentifier ?: @"missing";
    BOOL contained = [home containsString:[@"/Library/Containers/" stringByAppendingString:bundleId]] && [home hasSuffix:@"/Data"];
    emit(@{@"phase":@"parent", @"containerDetected":@(contained)});
    if (!contained || argc != 2) return 44;
    NSString *clone = [bundle.resourcePath stringByAppendingPathComponent:@"clone"];
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:[clone stringByAppendingPathComponent:@"runtime/node"]];
    task.arguments = @[[bundle.resourcePath stringByAppendingPathComponent:@"backend-probe.mjs"], home, [NSString stringWithUTF8String:argv[1]]];
    task.currentDirectoryURL = [NSURL fileURLWithPath:home];
    task.environment = @{@"HOME":home, @"PATH":@"/usr/bin:/bin", @"TMPDIR":NSTemporaryDirectory(), @"NODE_ENV":@"desktop", @"RECORD_LEARNING_ENABLED":@"false", @"LINGJI_LOCAL_ASR_DIR":[clone stringByAppendingPathComponent:@"client-backend/local-asr"], @"LINGJI_MACOS_SANDBOX_MODULE":[clone stringByAppendingPathComponent:@"runtime/sandbox-bookmarks.node"]};
    // Inherited descriptors avoid a full child pipe blocking the parent's waitUntilExit.
    task.standardOutput = [NSFileHandle fileHandleWithStandardOutput];
    task.standardError = [NSFileHandle fileHandleWithStandardError];
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) { emit(@{@"phase":@"launch", @"error":error.localizedDescription ?: @"unknown"}); return 45; }
    [task waitUntilExit];
    emit(@{@"phase":@"child-exit", @"terminationStatus":@(task.terminationStatus)});
    return task.terminationStatus == 0 ? 0 : 46;
  }
}

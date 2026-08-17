#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

/**
 * iOS counterpart of the Android-side host runtime modules
 * (CesiumAndroidRuntime + CesiumWindowInsets). It exposes:
 *
 *  - constants: the file URL of the bundled workbench (`workbench/index.html`
 *    copied into the .app as a folder resource) and the bundle root, which the
 *    WKWebView needs as `allowingReadAccessToURL` so subresources resolve.
 *  - getInsets: the key window's safe-area insets, streamed into the web layer
 *    as the same `--opencursor-mobile-safe-area-top` CSS variable Android uses.
 *
 * Legacy RCT_EXPORT_MODULE modules run through the new-architecture interop
 * layer, so no TurboModule spec is required.
 */
@interface CesiumIOSRuntime : NSObject <RCTBridgeModule>
@end

@implementation CesiumIOSRuntime

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSURL *workbenchIndex = [[NSBundle mainBundle] URLForResource:@"index"
                                                  withExtension:@"html"
                                                   subdirectory:@"workbench"];
  NSURL *bundleRoot = [[NSBundle mainBundle] bundleURL];
  return @{
    @"workbenchUrl" : workbenchIndex != nil ? workbenchIndex.absoluteString : [NSNull null],
    @"bundleRootUrl" : bundleRoot != nil ? bundleRoot.absoluteString : [NSNull null],
  };
}

RCT_EXPORT_METHOD(getInsets:(RCTPromiseResolveBlock)resolve
                  reject:(__unused RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
        if (candidate.isKeyWindow) {
          window = candidate;
          break;
        }
      }
      if (window != nil) {
        break;
      }
      window = ((UIWindowScene *)scene).windows.firstObject;
    }
    UIEdgeInsets insets = window != nil ? window.safeAreaInsets : UIEdgeInsetsZero;
    CGFloat statusBarTop = 0;
    UIWindowScene *windowScene = window.windowScene;
    if (windowScene != nil && windowScene.statusBarManager != nil) {
      statusBarTop = windowScene.statusBarManager.statusBarFrame.size.height;
    }
    resolve(@{
      @"safeAreaTop" : @(insets.top),
      @"statusBarTop" : @(statusBarTop),
      @"displayCutoutTop" : @(insets.top),
      @"safeAreaBottom" : @(insets.bottom),
    });
  });
}

@end

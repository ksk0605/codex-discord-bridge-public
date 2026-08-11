#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static const int32_t notFoundExitStatus = 44;
static const int32_t usageExitStatus = 64;
static const int32_t softwareExitStatus = 70;
static const NSUInteger maximumSecretBytes = 16 * 1024;
static const NSUInteger maximumNameBytes = 512;

static void writeStandardError(NSString *message) {
  NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  [[NSFileHandle fileHandleWithStandardError] writeData:data];
}

static BOOL validateName(NSString *value, NSString *label) {
  NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (value == nil || value.length == 0 || bytes == nil || bytes.length > maximumNameBytes) {
    writeStandardError([NSString stringWithFormat:@"invalid %@", label]);
    return NO;
  }
  if ([value rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location != NSNotFound) {
    writeStandardError([NSString stringWithFormat:@"invalid %@", label]);
    return NO;
  }
  return YES;
}

static NSData *readSecret(void) {
  NSMutableData *secret = [NSMutableData dataWithCapacity:maximumSecretBytes];
  uint8_t buffer[8 * 1024];

  while (YES) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count == 0) {
      break;
    }
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      writeStandardError(@"unable to read secret input");
      return nil;
    }
    if ((NSUInteger)count > maximumSecretBytes - secret.length) {
      writeStandardError(@"invalid secret size");
      return nil;
    }
    [secret appendBytes:buffer length:(NSUInteger)count];
  }

  if (secret.length == 0) {
    writeStandardError(@"invalid secret size");
    return nil;
  }
  return secret;
}

static NSMutableDictionary<id, id> * itemQuery(NSString *service, NSString *account) {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecAttrAccount: account,
  } mutableCopy];
}

static int32_t reportSecurityFailure(OSStatus status) {
  if (status == errSecItemNotFound) {
    writeStandardError(@"keychain item not found");
    return notFoundExitStatus;
  }
  writeStandardError([NSString stringWithFormat:@"keychain operation failed with OSStatus %d", (int)status]);
  return softwareExitStatus;
}

static int32_t setSecret(NSString *service, NSString *account, NSData *secret) {
  NSMutableDictionary<id, id> *addQuery = itemQuery(service, account);
  addQuery[(__bridge id)kSecValueData] = secret;

  OSStatus addStatus = SecItemAdd((__bridge CFDictionaryRef)addQuery, NULL);
  if (addStatus == errSecSuccess) {
    return 0;
  }
  if (addStatus != errSecDuplicateItem) {
    return reportSecurityFailure(addStatus);
  }

  NSDictionary<id, id> *updateAttributes = @{
    (__bridge id)kSecValueData: secret,
  };
  OSStatus updateStatus = SecItemUpdate(
    (__bridge CFDictionaryRef)itemQuery(service, account),
    (__bridge CFDictionaryRef)updateAttributes
  );
  if (updateStatus == errSecSuccess) {
    return 0;
  }
  return reportSecurityFailure(updateStatus);
}

static int32_t getSecret(NSString *service, NSString *account) {
  NSMutableDictionary<id, id> *query = itemQuery(service, account);
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;

  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status != errSecSuccess) {
    return reportSecurityFailure(status);
  }

  NSData *secret = CFBridgingRelease(result);
  if (![secret isKindOfClass:[NSData class]] || secret.length == 0 || secret.length > maximumSecretBytes) {
    writeStandardError(@"keychain returned invalid secret data");
    return softwareExitStatus;
  }
  [[NSFileHandle fileHandleWithStandardOutput] writeData:secret];
  return 0;
}

static int32_t deleteSecret(NSString *service, NSString *account) {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)itemQuery(service, account));
  if (status == errSecSuccess) {
    return 0;
  }
  return reportSecurityFailure(status);
}

static NSComparisonResult compareAccountNames(id leftValue, id rightValue, void *context) {
  (void)context;
  NSString *left = leftValue;
  NSString *right = rightValue;
  NSData *leftBytes = [left dataUsingEncoding:NSUTF8StringEncoding];
  NSData *rightBytes = [right dataUsingEncoding:NSUTF8StringEncoding];
  NSUInteger commonLength = MIN(leftBytes.length, rightBytes.length);
  int comparison = commonLength == 0 ? 0 : memcmp(leftBytes.bytes, rightBytes.bytes, commonLength);
  if (comparison < 0 || (comparison == 0 && leftBytes.length < rightBytes.length)) {
    return NSOrderedAscending;
  }
  if (comparison > 0 || (comparison == 0 && leftBytes.length > rightBytes.length)) {
    return NSOrderedDescending;
  }
  return NSOrderedSame;
}

static int32_t writeAccountList(NSArray<NSString *> *accounts) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:accounts options:0 error:&error];
  if (data == nil || error != nil) {
    writeStandardError(@"unable to encode keychain account list");
    return softwareExitStatus;
  }
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  return 0;
}

static int32_t listAccounts(NSString *service) {
  NSDictionary<id, id> *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecReturnAttributes: @YES,
    (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll,
  };
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    return writeAccountList(@[]);
  }
  if (status != errSecSuccess) {
    return reportSecurityFailure(status);
  }

  NSArray *items = CFBridgingRelease(result);
  if (![items isKindOfClass:[NSArray class]]) {
    writeStandardError(@"keychain returned invalid account attributes");
    return softwareExitStatus;
  }

  NSMutableArray<NSString *> *accounts = [NSMutableArray arrayWithCapacity:items.count];
  for (id item in items) {
    if (![item isKindOfClass:[NSDictionary class]]) {
      writeStandardError(@"keychain returned invalid account attributes");
      return softwareExitStatus;
    }
    id account = ((NSDictionary *)item)[(__bridge id)kSecAttrAccount];
    if (![account isKindOfClass:[NSString class]] || !validateName(account, @"account")) {
      writeStandardError(@"keychain returned invalid account attributes");
      return softwareExitStatus;
    }
    [accounts addObject:account];
  }

  NSSet<NSString *> *uniqueAccounts = [NSSet setWithArray:accounts];
  if (uniqueAccounts.count != accounts.count) {
    writeStandardError(@"keychain returned duplicate account attributes");
    return softwareExitStatus;
  }
  NSArray<NSString *> *sortedAccounts = [accounts sortedArrayUsingFunction:compareAccountNames context:NULL];
  return writeAccountList(sortedAccounts);
}

static NSString *argumentAt(int argc, const char *argv[], int index) {
  if (index >= argc) {
    return nil;
  }
  return [[NSString alloc] initWithUTF8String:argv[index]];
}

static int32_t run(int argc, const char *argv[]) {
  NSString *command = argumentAt(argc, argv, 1);
  if (command == nil) {
    writeStandardError(@"usage: keychain-helper <set|get|delete|list> ...");
    return usageExitStatus;
  }

  if ([command isEqualToString:@"set"]) {
    if (argc != 4) {
      writeStandardError(@"usage: keychain-helper set <service> <account>");
      return usageExitStatus;
    }
    NSString *service = argumentAt(argc, argv, 2);
    NSString *account = argumentAt(argc, argv, 3);
    if (!validateName(service, @"service") || !validateName(account, @"account")) {
      return usageExitStatus;
    }
    NSData *secret = readSecret();
    if (secret == nil) {
      return usageExitStatus;
    }
    return setSecret(service, account, secret);
  }

  if ([command isEqualToString:@"get"] || [command isEqualToString:@"delete"]) {
    if (argc != 4) {
      writeStandardError([NSString stringWithFormat:@"usage: keychain-helper %@ <service> <account>", command]);
      return usageExitStatus;
    }
    NSString *service = argumentAt(argc, argv, 2);
    NSString *account = argumentAt(argc, argv, 3);
    if (!validateName(service, @"service") || !validateName(account, @"account")) {
      return usageExitStatus;
    }
    return [command isEqualToString:@"get"] ? getSecret(service, account) : deleteSecret(service, account);
  }

  if ([command isEqualToString:@"list"]) {
    if (argc != 3) {
      writeStandardError(@"usage: keychain-helper list <service>");
      return usageExitStatus;
    }
    NSString *service = argumentAt(argc, argv, 2);
    if (!validateName(service, @"service")) {
      return usageExitStatus;
    }
    return listAccounts(service);
  }

  writeStandardError(@"unknown keychain helper command");
  return usageExitStatus;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    return run(argc, argv);
  }
}

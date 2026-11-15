#!/usr/bin/env bash
# Đổi mã định danh ứng dụng (Android applicationId + iOS bundle id) trong một lệnh.
# PHẢI làm trước lần phát hành đầu tiên; sau đó không đổi được nữa.
#   ./scripts/doi-ma-ung-dung.sh vn.congty.chat
set -euo pipefail
NEW="${1:-}"
if [[ ! "$NEW" =~ ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$ ]]; then
  echo "Mã không hợp lệ. Dạng đúng: vn.congty.chat (chữ thường, số, gạch dưới, ngăn bằng dấu chấm)" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
OLD_ANDROID="vn.noibo.chat_noibo"
OLD_IOS="vn.noibo.chatNoibo"
NEW_IOS="${NEW//_/-}"   # iOS không cho dấu gạch dưới

if ! grep -q "$OLD_ANDROID" android/app/build.gradle.kts; then
  echo "Mã ứng dụng đã được đổi trước đó, không làm gì." >&2
  exit 1
fi

# Android: namespace, applicationId, package của MainActivity và vị trí thư mục.
sed -i.bak "s/$OLD_ANDROID/$NEW/g" android/app/build.gradle.kts && rm android/app/build.gradle.kts.bak
OLD_DIR="android/app/src/main/kotlin/${OLD_ANDROID//.//}"
NEW_DIR="android/app/src/main/kotlin/${NEW//.//}"
mkdir -p "$NEW_DIR"
mv "$OLD_DIR/MainActivity.kt" "$NEW_DIR/MainActivity.kt"
find android/app/src/main/kotlin -type d -empty -delete
sed -i.bak "s/^package .*/package $NEW/" "$NEW_DIR/MainActivity.kt" && rm "$NEW_DIR/MainActivity.kt.bak"

# iOS: bundle id trong dự án Xcode và trong cấu hình Firebase của app.
sed -i.bak "s/$OLD_IOS/$NEW_IOS/g" ios/Runner.xcodeproj/project.pbxproj && rm ios/Runner.xcodeproj/project.pbxproj.bak
sed -i.bak "s/iosBundleId: '$OLD_IOS'/iosBundleId: '$NEW_IOS'/" lib/push.dart && rm lib/push.dart.bak

echo "Đã đổi: Android = $NEW, iOS = $NEW_IOS"
echo "Nhớ đăng ký đúng hai mã này khi thêm app Android/iOS trong Firebase."

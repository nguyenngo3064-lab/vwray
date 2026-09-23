# Tiến độ dở lại

## Files đang làm

### src/server/analytics/insights.ts
- [x] `trafficInsights(preset, filters?)`:
  - Ép `preset` -> `string` (`preset ?? "today"`) -> hết lỗi TS2322.
  - Guard `resolved === null` -> trả `available: false`, `reason: "The requested time range is invalid."`.
  - `filters`: deviceId, nodeId, userId, configId -> chuyển thành `dimKey` prefix (`device:`, `node:`, `user:`, `config:`); khi có filter dùng `eq`, khi không dùng `startsWith` (hiệu năng + đúng scope).
  - `filters.category`: `eq` khi có, `not: null` khi không.
  - `filters.source`: lọc `where.source` (REAL/MOCK); biến `mockOnly` = `source==="MOCK"` để tắt câu "ALL FIGURES COME FROM REAL..." khi chọn MOCK.
  - Biến `realOnly` = count REAL buckets -> dùng ở câu cuối cùng (sửa từ `mockOnly` variable name collision).
  - `byDirection` / `buckets`: áp dụng `deviceDim` filter khi có scope.
  - Fix 2 lỗi `preset` undefined ở `totalBytes === 0n` return + final return -> dùng `range.preset`.

### src/app/api/insights/route.ts
- [x] `GET`: parse `searchParams` (preset + deviceId/nodeId/userId/configId/category/source) -> truyền vào `trafficInsights`.
- [x] `rateLimit: { limit: 60, windowSeconds: 60 }`.

## Tổng quan tsc
```
npx tsc --noEmit | grep 'error TS' | grep -v 'console/bits'
```
Hiện tại: **0 lỗi** (tính đến lúc ghi file này).

## Còn lại / chú ý
- Không sửa gì thêm nữa (theo chỉ đạo).
- Nếu có thay đổi phụ thuộc (ví dụ domain event schema) thì cần cập nhật tiếp.

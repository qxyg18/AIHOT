// All upstream fetchers, in the order a refresh runs them. zw12 改造：AI 评测源随 v15 退役下线
// （源文件保留在 sources/ 目录不再注册），两榜数据面=站内声量引擎+人工补录+热搜哨兵。
// 顺序约束：manual-supplement 先行（实体身份全量预写在别名表，任何后续源都能命中）。
import { internalSignal } from "./sources/internal-signal.ts";
import { manualSupplement } from "./sources/manual-supplement.ts";
import { dailyhot } from "./sources/dailyhot.ts";
import type { Fetcher } from "./types.ts";

export const FETCHERS: Fetcher[] = [manualSupplement, internalSignal, dailyhot];

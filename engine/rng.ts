// 种子化随机 —— 黄金法则 1 的**唯一**随机入口（AGENT.md §2 / §5.3）
//
// 设计约束（三条，缺一不可）：
// 1. 零依赖、零宿主 API（黄金法则 2）：不得引用 node:* / DOM / 全局随机源；
// 2. 确定性：同一 seed 必然产生同一序列，且**不依赖任何隐式状态**——实例自带状态，
//    不允许模块级可变状态（否则多个对局会互相污染，批量模拟必然不可复现）；
// 3. 状态可随 BattleState 一起克隆：确定性回归要求"快照 → 重放"能对齐，
//    因此 clone() 必须复制内部状态而不是共享引用。
//
// 算法：mulberry32（32 位状态、单轮混合）。选它而非 xoroshiro 的理由：
// 本模拟器的随机消耗量是每触发帧个位数、单局数千次，mulberry32 的周期（2^32）
// 与统计质量远超需求，而实现只有 6 行、纯整数运算、无浮点误差累积。

const UINT32_RANGE = 4294967296; // 2^32

// 混合常数（mulberry32 标准取值，改动即破坏全部历史基准 hash）
const MIX_1 = 0x6d2b79f5;

export class Rng {
  /** 内部状态（uint32）。私有字段是可擦除语法，不会被 tsc emit。 */
  #state: number;

  /**
   * @param seed 任意整数；会先折叠到 uint32 空间。同一 seed 必然得到同一序列。
   * @throws 若 seed 不是有限数（NaN / Infinity），抛 Error —— 非有限种子等于放弃确定性。
   */
  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new Error(`Rng 种子必须是有限数，收到 ${String(seed)}`);
    }
    // 用位运算折叠到 uint32：负数与小数都能得到一个稳定、可复现的初值
    this.#state = Math.trunc(seed) >>> 0;
  }

  /** 当前内部状态的快照（只读用途：调试与日志；不得用来恢复状态） */
  get state(): number {
    return this.#state;
  }

  /** 产生下一个 uint32，并推进内部状态 */
  nextUint32(): number {
    this.#state = (this.#state + MIX_1) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * 产生 [0, 1) 的浮点数。
   * 注意：只用于**表现层概率判定**（如暴击、命中）；一切影响战斗结果的核心随机
   * 都应优先用 nextInt，避免浮点比较在不同平台上产生分歧。
   */
  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  /**
   * 产生 [0, maxExclusive) 的整数。
   * @throws 若 maxExclusive 不是正整数，或超过 2^32。
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
      throw new Error(`nextInt 需要 (0, 2^32] 范围内的整数上界，收到 ${String(maxExclusive)}`);
    }
    // 取模偏差在 maxExclusive 远小于 2^32（本模拟器的实际情况）时可忽略；
    // 若将来需要严格均匀，改为拒绝采样即可，但**会改变历史序列**，须重算基准。
    return this.nextUint32() % maxExclusive;
  }

  /**
   * 原地洗牌（Fisher–Yates），使用本实例的随机数。
   * @param items 会被就地修改；如需保留入参请先自行复制。
   * @returns 同一个数组引用（便于链式使用）。
   */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const a = items[i];
      const b = items[j];
      // noUncheckedIndexedAccess 下 i / j 都是合法下标（j < i+1 <= length），但类型上仍是可选，
      // 故此处显式判空；这是纯防御，正常路径不会触发。
      if (a === undefined || b === undefined) continue;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /** 从非空数组中等概率取一个元素 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('pick 不能用于空数组');
    }
    const picked = items[this.nextInt(items.length)];
    if (picked === undefined) {
      throw new Error('pick 取到了空值：数组长度与实际内容不一致');
    }
    return picked;
  }

  /**
   * 复制一个状态完全相同的生成器（含内部状态）。
   * 用途：战斗快照 / 分支重放——确定性回归要求"从同一快照出发必然得到同一结果"。
   */
  clone(): Rng {
    const copy = new Rng(0);
    copy.#state = this.#state;
    return copy;
  }
}

/**
 * dsh-router-codebuddy —— DSH 插件 host half，一次注册**同族两个供应商**。
 *
 * 通过 cordis service `router.suppliers`（聚合表 `{ [supplierId]: (env) => SupplierModule }`）
 * 把 codebuddy 族供应商工厂暴露给 dsh-router：
 *   - `codebuddy`    国内 CodeBuddy（copilot.tencent.com）
 *   - `codebuddy-en` WorkBuddy 国际版（www.workbuddy.ai）
 * 两者共用 core.ts 的同一份实现，差异只在 cn.ts / en.ts 的 profile。
 *
 * 一个插件挂多个供应商是核心本就支持的形状（dsh-router 自己内置的
 * opencode/openrouter/nvidia 就是同一个包三个供应商）；合进一个包还顺带消掉了
 * 两个插件各自注册时的一个隐患：核心注销外部供应商用的是**共享**的 id 列表，
 * 任一插件卸载会把另一个的供应商一起注销。
 *
 * cordis 的 `ctx.provide` 每个 service name 只允许一个插件注册，多个供应商插件不能各自
 * provide `router.suppliers`（会抛 "service has been registered"）。本插件用共享表模式：
 * `inject` 等待该 service（由核心 dsh-router 持有空表），把工厂追加进共享表后广播一次
 * `internal/service`，让 dsh-router 重新扫描（其处理器按 live 表读取且幂等）。该模式与
 * 插件加载顺序无关：dsh-router 的 on 监听与 inject 兜底总有一条路径能读到追加后的 live 表。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSupplier } from './core.ts'
import { profile as cnProfile } from './cn.ts'
import { profile as enProfile } from './en.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

export const name = 'dsh-router-codebuddy'

/** 暴露给 dsh-router 的供应商工厂表。 */
export interface RouterSuppliersService {
  [supplierId: string]: (env: SupplierEnv) => SupplierModule
}

/** 本插件注册的全部供应商（profile → 工厂）。 */
const SUPPLIERS: ReadonlyArray<readonly [string, (env: SupplierEnv) => SupplierModule]> = [
  [cnProfile.id, createSupplier(cnProfile)],
  [enProfile.id, createSupplier(enProfile)],
]

/** 读取当前 router.suppliers 聚合表（同一 live 对象，可追加）。 */
function currentSuppliers(ctx: Context): RouterSuppliersService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { suppliers?: RouterSuppliersService }
  }
  return (c.get?.('router.suppliers') ?? c.router?.suppliers) as RouterSuppliersService | undefined
}

export function apply(ctx: Context): void {
  // 等 router.suppliers 可用后，把两个供应商追加进共享聚合表并通知 dsh-router 重扫。
  ctx.inject(['router.suppliers'], (sctx) => {
    const suppliers = currentSuppliers(sctx)
    if (!suppliers) return undefined
    const added: string[] = []
    for (const [id, factory] of SUPPLIERS) {
      if (suppliers[id]) continue
      suppliers[id] = factory
      added.push(id)
    }
    if (added.length > 0) {
      // 复用 dsh-router 的 internal/service 监听（读 live 表、幂等），增量加载。
      // 一次广播带上整张表：核心的 loadExternal 按 id 幂等，重复项直接跳过。
      ctx.emit('internal/service', 'router.suppliers', suppliers)
      ctx.logger?.info?.(`[dsh-router-codebuddy] registered router.suppliers: ${added.join(', ')}`)
    }
    return () => {
      for (const [id] of SUPPLIERS) delete suppliers[id]
    }
  })
}

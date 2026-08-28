/**
 * dsh-router-codebuddy —— DSH 插件 host half。
 *
 * 通过 cordis service `router.suppliers`（聚合表 `{ [supplierId]: (env) => SupplierModule }`）
 * 把 codebuddy 供应商工厂暴露给 dsh-router。
 *
 * cordis 的 `ctx.provide` 每个 service name 只允许一个插件注册，多个供应商插件不能各自
 * provide `router.suppliers`（会抛 "service has been registered"）。本插件用共享表模式：
 * `inject` 等待该 service（由先提供聚合表的插件持有，如 dsh-router-traework），把 `codebuddy`
 * 工厂追加进共享表后广播一次 `internal/service`，让 dsh-router 重新扫描（其处理器按 live 表
 * 读取且幂等）。该模式与插件加载顺序无关：dsh-router 的 on 监听与 inject 兜底总有一条路径
 * 能读到追加后的 live 表。
 */
import type { Context } from '@deepseek-ai/cordis'
import factory from './plugin.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

export const name = 'dsh-router-codebuddy'

/** 暴露给 dsh-router 的供应商工厂表。 */
export interface RouterSuppliersService {
  [supplierId: string]: (env: SupplierEnv) => SupplierModule
}

/** 读取当前 router.suppliers 聚合表（同一 live 对象，可追加）。 */
function currentSuppliers(ctx: Context): RouterSuppliersService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { suppliers?: RouterSuppliersService }
  }
  return (c.get?.('router.suppliers') ?? c.router?.suppliers) as RouterSuppliersService | undefined
}

export function apply(ctx: Context): void {
  // 等 router.suppliers 可用后，把 codebuddy 追加进共享聚合表并通知 dsh-router 重扫。
  ctx.inject(['router.suppliers'], (sctx) => {
    const suppliers = currentSuppliers(sctx)
    if (!suppliers) return undefined
    if (!suppliers.codebuddy) {
      suppliers.codebuddy = factory
      // 复用 dsh-router 的 internal/service 监听（读 live 表、幂等），增量加载 codebuddy。
      ctx.emit('internal/service', 'router.suppliers', suppliers)
      ctx.logger?.info?.('[dsh-router-codebuddy] registered router.suppliers: codebuddy')
    }
    return () => {
      delete suppliers.codebuddy
    }
  })
}

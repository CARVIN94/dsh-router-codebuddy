/**
 * 供应商通用类型 —— 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 router/types.ts 保持同步。
 */
import type { ServerResponse } from 'node:http'

/** 面板展示的账号状态（脱敏）。 */
export interface SupplierAccount {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  disabled: boolean
  err_count?: number
}

/** 供应商面板状态。 */
export interface SupplierStatus {
  id: string
  name: string
  accounts: SupplierAccount[]
}

/** OpenAI 模型条目。 */
export interface ModelInfo {
  id: string
  context_length?: number
}

/** 一次 /v1/chat/completions 请求。 */
export interface ChatRequest {
  rawBody: string
  stream: boolean
  model: string
}

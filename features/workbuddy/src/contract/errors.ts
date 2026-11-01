import { defineErrors } from '@poietica/contract-kit'

export const workbuddyErrors = defineErrors('workbuddy', {
  account_not_found: 'WorkBuddy 账号不存在',
  not_signed_in: '请先登录 WorkBuddy 账号',
  login_failed: 'WorkBuddy 登录失败，请重试',
  login_cancelled: 'WorkBuddy 登录已取消',
  usage_failed: '读取 WorkBuddy 积分失败',
  checkin_failed: 'WorkBuddy 签到失败',
  provider_conflict: '模型服务商 workbuddy 已被占用，无法注册内置反代',
  proxy_failed: '内置反代启动失败',
  disabled: '内置反代未启用',
})

import { ConfigurationError, readServerConfig } from '../server/config.mjs'

try {
  readServerConfig({ ...process.env, NODE_ENV: 'production' })
  console.log('生产配置静态检查通过；未连接数据库、对象存储或模型，不代表线上可用。')
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : '生产配置检查失败；请核对变量与 CA 文件。')
  process.exitCode = 1
}

import { ENVIRONMENT } from '../types'
import { createProcessReadGateway } from './processGateway'

export const processReadGateway = createProcessReadGateway(async (action, request) => {
  const { invokeProcessRead } = await import('./processApiClient')
  return invokeProcessRead(action, request)
}, ENVIRONMENT.url)

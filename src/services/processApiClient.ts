import { getClient } from '@microsoft/power-apps/data'
import { dataSourcesInfo } from '../../.power/schemas/appschemas/dataSourcesInfo'
import { processTrackingMetadata } from '../generated/processTrackingMetadata'
import type { ProcessReadAction } from './processGateway'

const client = getClient({ ...dataSourcesInfo, ...processTrackingMetadata })

export async function invokeProcessRead(action: ProcessReadAction, request: Record<string, unknown>): Promise<unknown> {
  // API paths/parameters are generated from the same contract as the plug-in.
  // Authentication and environment routing remain inside the Power Apps SDK.
  const result = await client.executeAsync<{ RequestJson: string }, { ResponseJson: string }>({
    dataverseRequest: {
      action: 'customapi',
      parameters: { operationName: action, tableName: 'processTracking', body: { RequestJson: JSON.stringify(request) } },
    },
  })
  if (!result.success) throw new Error(`Process service unavailable: ${result.error?.message || 'the Dataverse operation failed.'}`)
  if (!result.data || typeof result.data.ResponseJson !== 'string') throw new Error('Process service returned no versioned response.')
  return JSON.parse(result.data.ResponseJson)
}

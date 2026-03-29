import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { MessageTarget } from '../../core/types.ts'
import type { RouteEntry } from './types.ts'

export const messageRoutes: RouteEntry[] = [
  {
    method: 'POST',
    pattern: /^\/api\/messages$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.content || !body.senderId) return errorResponse('content and senderId are required')
      const target = (body.target as MessageTarget) ?? {}
      const senderId = body.senderId as string
      const senderAgent = system.team.getAgent(senderId)
      const messages = system.routeMessage(target, {
        senderId,
        senderName: (body.senderName as string | undefined) ?? senderAgent?.name,
        content: body.content as string,
        type: (body.messageType as 'chat') ?? 'chat',
        metadata: body.metadata as Record<string, unknown> | undefined,
      })
      return json(messages, 201)
    },
  },
]

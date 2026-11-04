import { memo, useState } from 'react'
import { initials } from './slack-chats-utils'

/** A person's Slack photo, falling back to their initials when there is none or it fails to load. */
export const ChatAvatar = memo(function ChatAvatar({ name, image, large, small }: { name: string; image?: string; large?: boolean; small?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null)
  const cls = `slchat-avatar${large ? ' slchat-avatar--lg' : ''}${small ? ' slchat-avatar--sm' : ''}`
  if (image && failed !== image) {
    return <img className={`${cls} slchat-avatar--img`} src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(image)} />
  }
  return <span className={cls} aria-hidden="true">{initials(name)}</span>
})

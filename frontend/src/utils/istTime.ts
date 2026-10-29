/**
 * IST (Asia/Kolkata) time utilities
 * Use these instead of new Date() for any user-facing time display
 */

export function getNowIST(): Date {
  const now = new Date()
  const istString = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  return new Date(istString + ' GMT+0530')
}

export function getISTHours(date: Date = new Date()): number {
  const istString = date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
  return parseInt(istString.split(':')[0])
}

export function getISTMinutes(date: Date = new Date()): number {
  const istString = date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
  return parseInt(istString.split(':')[1])
}

export function formatISTTime(date: Date = new Date(), format: '12h' | '24h' = '12h'): string {
  const istString = date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: format === '12h'
  })
  return istString
}

export function getISTDate(date: Date = new Date()): string {
  return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
}

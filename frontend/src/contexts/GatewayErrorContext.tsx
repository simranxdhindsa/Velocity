import { createContext, useCallback, useContext, useState } from 'react'
export { GatewayError } from '@/services/api'

interface GatewayErrorContextValue {
  isDown: boolean
  trigger: () => void
  clear: () => void
}

const GatewayErrorContext = createContext<GatewayErrorContextValue>({
  isDown: false,
  trigger: () => {},
  clear: () => {},
})

export function GatewayErrorProvider({ children }: { children: React.ReactNode }) {
  const [isDown, setIsDown] = useState(false)

  const trigger = useCallback(() => setIsDown(true), [])
  const clear = useCallback(() => setIsDown(false), [])

  return (
    <GatewayErrorContext.Provider value={{ isDown, trigger, clear }}>
      {children}
    </GatewayErrorContext.Provider>
  )
}

export function useGatewayError() {
  return useContext(GatewayErrorContext)
}

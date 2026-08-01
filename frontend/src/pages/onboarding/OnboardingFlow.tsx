import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/AuthContext'
import OnboardingShell from './OnboardingShell'
import OnboardingWelcome from './OnboardingWelcome'
import OnboardingIntro from './OnboardingIntro'
import OnboardingYouTrack from './OnboardingYouTrack'
import OnboardingSlack from './OnboardingSlack'
import OnboardingReady from './OnboardingReady'

const STEPS = ['welcome', 'intro', 'youtrack', 'slack', 'ready'] as const

export default function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const { user } = useAuth()
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]

  const next = () => setStepIdx(i => Math.min(i + 1, STEPS.length - 1))
  const back = () => setStepIdx(i => Math.max(i - 1, 0))

  return (
    <OnboardingShell
      stepIdx={stepIdx}
      totalSteps={STEPS.length}
      onBack={stepIdx > 0 ? back : undefined}
      onSkipAll={onFinish}
    >
      <AnimatePresence mode="wait">
        {step === 'welcome'  && <OnboardingWelcome key="welcome" userName={user?.name} onNext={next} />}
        {step === 'intro'    && <OnboardingIntro key="intro" onNext={next} />}
        {step === 'youtrack' && <OnboardingYouTrack key="youtrack" onNext={next} onSkip={next} />}
        {step === 'slack'    && <OnboardingSlack key="slack" onNext={next} onSkip={next} />}
        {step === 'ready'    && <OnboardingReady key="ready" onFinish={onFinish} />}
      </AnimatePresence>
    </OnboardingShell>
  )
}

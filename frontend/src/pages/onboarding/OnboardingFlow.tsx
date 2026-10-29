import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/AuthContext'
import OnboardingShell from './OnboardingShell'
import OnboardingWelcome from './OnboardingWelcome'
import OnboardingIntro from './OnboardingIntro'
import OnboardingYouTrack from './OnboardingYouTrack'
import OnboardingSlack from './OnboardingSlack'
import OnboardingReady from './OnboardingReady'
import OnboardingComplete from './OnboardingComplete'

const STEPS = ['welcome', 'intro', 'youtrack', 'slack', 'ready'] as const

// ?step=ready (or a numeric index) jumps straight there — handy for previewing
// a single screen (e.g. the completion animation) without clicking through.
function initialStepFromQuery(raw: string | null): number {
  if (!raw) return 0
  const byName = STEPS.indexOf(raw as typeof STEPS[number])
  if (byName >= 0) return byName
  const byIdx = parseInt(raw, 10)
  return Number.isFinite(byIdx) ? Math.min(Math.max(byIdx, 0), STEPS.length - 1) : 0
}

export default function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [stepIdx, setStepIdx] = useState(() => initialStepFromQuery(searchParams.get('step')))
  const [finishing, setFinishing] = useState(false)
  const step = STEPS[stepIdx]

  const next = () => setStepIdx(i => Math.min(i + 1, STEPS.length - 1))
  const back = () => setStepIdx(i => Math.max(i - 1, 0))

  if (finishing) {
    return <OnboardingComplete onDone={onFinish} />
  }

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
        {step === 'ready'    && <OnboardingReady key="ready" onFinish={() => setFinishing(true)} />}
      </AnimatePresence>
    </OnboardingShell>
  )
}

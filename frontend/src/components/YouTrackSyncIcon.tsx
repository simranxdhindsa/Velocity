import { motion, useReducedMotion } from 'framer-motion'

// The YouTrack ribbon mark, traced from https://upload.wikimedia.org/wikipedia/commons/8/85/YouTrack_icon.svg
const RIBBON_PATH =
  'M1.30634 51.2446c-.09688-.0713-.12875-.2019-.07625-.31L8.86571 35.209.058214 24.6908c-.08875-.1056-.074375-.2637.031875-.3518L25.7788 2.93209C30.3495-.877908 36.967-.985408 41.6626 2.67147c4.6937 3.65687 6.1937 10.08813 3.5969 15.43623l-2.7994 5.7669c1.0919-.3663 2.1725-.6994 3.2412-.9988l12.6738-3.6406c.1381-.04.2819.045.3131.1856l5.3056 23.585c.0325.1457-.0662.2882-.215.3069-1.6818.2119-10.8575 1.53-22.2812 6.3294-12.9431 5.4362-21.4844 13.1625-22.6944 14.2925-.0894.0837-.2206.0869-.3187.0144L1.30634 51.2446Z'

interface YouTrackSyncIconProps {
  size?: number
  /** While true, the ribbon outline continuously traces itself like a sketch. */
  scanning: boolean
}

/**
 * The YouTrack icon, with its ribbon shape animatable while a sync is running —
 * the outline draws itself in a loop (framer-motion pathLength), settling back
 * to the exact same static filled icon when scanning stops.
 */
export function YouTrackSyncIcon({ size = 18, scanning }: YouTrackSyncIconProps) {
  const prefersReducedMotion = useReducedMotion()
  const looping = scanning && !prefersReducedMotion

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="yt-sync-grad" x1="-.102411" x2="64.0532" y1="32.0002" y2="32.0002" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FB43FF" />
          <stop offset=".97" stopColor="#FB406D" />
        </linearGradient>
      </defs>
      <motion.path
        d={RIBBON_PATH}
        fill="url(#yt-sync-grad)"
        stroke="url(#yt-sync-grad)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        // Each cycle: trace the outline first (0 → 60%), then the solid ribbon
        // sweeps in behind it (60% → 100%), then loops back to a blank trace.
        animate={looping
          ? { pathLength: [0, 1, 1], fillOpacity: [0, 0, 1], strokeOpacity: [1, 1, 0] }
          : { pathLength: 1, fillOpacity: 1, strokeOpacity: 0 }}
        transition={looping
          ? { duration: 1.6, repeat: Infinity, times: [0, 0.6, 1], ease: 'easeInOut' }
          : { duration: 0.25 }}
      />
      <path fill="#000" d="M52 12H12v40h40V12Z" />
      <path fill="#fff" d="m21.4666 26.3709-5.4881-9.3787h3.1513l3.3981 5.9919.3969.8575.3968-.8682 3.3119-5.9812h3.0975l-5.4025 9.3575v5.6487h-2.8619v-5.6275Z" />
      <path fill="#fff" d="M33 43.9984H17v3h16v-3Z" />
      <path fill="#fff" d="M42.3248 16.9922H30.2879l-.0006 2.6369h4.5662v12.3693h2.9263V19.6291h4.545v-2.6369Z" />
    </svg>
  )
}

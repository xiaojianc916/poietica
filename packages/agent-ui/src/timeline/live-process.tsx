import './live-process.css'

import type { FeedRow } from '@poietica/agent'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, type ReactNode } from 'react'

const EASE: [number, number, number, number] = [0.2, 0, 0, 1]
const ARRIVE = { duration: 0.18, ease: EASE }
const LEAVE = { duration: 0.16, ease: EASE }
const AT_ONCE = { duration: 0 }
const DRIFT_PX = 4

export interface LiveProcessProps {
  readonly rows: readonly FeedRow[]
  readonly renderRow: (row: FeedRow) => ReactNode
}

/**
 * The live tail owns presence only. Exiting rows leave layout immediately via
 * popLayout; opacity and transform animate the snapshot without feeding
 * intermediate heights back into the transcript virtualizer.
 */
export const LiveProcess = memo(function LiveProcess({ renderRow, rows }: LiveProcessProps) {
  const still = useReducedMotion() === true
  const transition = still ? AT_ONCE : ARRIVE

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {rows.map((row) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="live-process__slot"
          exit={{ opacity: 0, transition: still ? AT_ONCE : LEAVE, y: -DRIFT_PX }}
          initial={{ opacity: 0, y: DRIFT_PX }}
          key={row.item.id}
          layout="position"
          transition={transition}
        >
          <div className="live-process__frame" data-type={row.item.type}>
            {renderRow(row)}
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
})

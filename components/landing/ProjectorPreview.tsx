'use client'

import { useEffect, useRef, useState } from 'react'
import { useInView, useReducedMotion } from 'motion/react'
import { ProjectorSlide } from '@/components/ProjectorSlide'

const QUESTION = {
  prompt: 'What does diffusion of responsibility describe?',
  options: [
    { id: 'a', text: 'Nobody helps, because each person assumes somebody else will' },
    { id: 'b', text: 'A crowd decides faster than one person would' },
    { id: 'c', text: 'Responsibility passes to whoever has the most training' },
    { id: 'd', text: 'Group members split a task into equal shares' },
  ],
}

const WINDOW_MS = 20_000

/**
 * The projector, running. Same ProjectorSlide the host console renders, inside the same
 * drain-bar-and-room-code chrome, so what a visitor sees on the marketing page is what goes
 * on the wall. The clock only runs while the preview is on screen.
 */
export function ProjectorPreview({ code = '402913' }: { code?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.4 })
  const reduce = useReducedMotion()
  const [left, setLeft] = useState(WINDOW_MS)

  useEffect(() => {
    if (!inView || reduce) return
    const id = setInterval(() => setLeft((ms) => (ms <= 250 ? WINDOW_MS : ms - 250)), 250)
    return () => clearInterval(id)
  }, [inView, reduce])

  const seconds = Math.ceil(left / 1000)
  const urgent = seconds <= 5

  return (
    <div ref={ref} className="overflow-hidden rounded-plate border border-rule bg-ground">
      <div className="h-1.5 w-full bg-rule" aria-hidden suppressHydrationWarning>
        <div
          className={`h-full transition-[width] duration-200 ease-linear ${urgent ? 'bg-wrong' : 'bg-lamp'}`}
          style={{ width: `${(left / WINDOW_MS) * 100}%` }}
        />
      </div>
      <div className="flex items-end justify-between gap-6 border-b border-rule px-6 py-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">
            Room code
          </div>
          <div className="font-data mt-1 text-2xl leading-none tracking-[0.14em] text-lamp">
            {code}
          </div>
        </div>
        <div suppressHydrationWarning className={`font-data text-2xl tabular-nums ${urgent ? 'text-wrong' : 'text-lamp'}`}>
          {seconds}
        </div>
      </div>
      <div className="p-6">
        <ProjectorSlide prompt={QUESTION.prompt} options={QUESTION.options} size="preview" />
      </div>
    </div>
  )
}

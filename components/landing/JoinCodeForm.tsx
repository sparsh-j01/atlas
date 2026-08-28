'use client'

import { ArrowRight } from '@phosphor-icons/react/ssr'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { btn, capCls, inputCls } from '@/components/ui'

/**
 * The participant front door. Six digits is the whole login, which is the point,
 * so the code goes straight into the largest input on the page and hands off to
 * /play with the code already filled in.
 */
export function JoinCodeForm() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (code.length < 6) {
      setError('Room codes are six digits. Ask your teacher for the code on screen.')
      return
    }
    setError('')
    setBusy(true)
    router.push(`/play?code=${code}`)
  }

  return (
    <form onSubmit={submit} noValidate className="flex w-full flex-col gap-3">
      <label htmlFor="room-code" className={capCls}>
        Room code
      </label>

      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="room-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
            if (error) setError('')
          }}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'room-code-error' : undefined}
          className={`${inputCls} py-4 font-data text-3xl tabular-nums tracking-[0.28em] sm:flex-1`}
          placeholder="000000"
        />
        <button
          type="submit"
          disabled={busy}
          className={btn('primary', 'xl')}
        >
          {busy ? 'Joining' : 'Join a room'}
          <ArrowRight size={20} weight="regular" aria-hidden />
        </button>
      </div>

      {error ? (
        <p id="room-code-error" role="alert" className="text-sm text-wrong">
          {error}
        </p>
      ) : (
        <p className={capCls}>No account needed. Pick a nickname on the next screen.</p>
      )}
    </form>
  )
}

'use client'

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

function SSOPage() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")

  return (
    <div style={{padding:40}}>
      <h1>SSO Login</h1>
      <p>Token: {token}</p>
    </div>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SSOPage />
    </Suspense>
  )
}

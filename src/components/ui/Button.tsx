import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon'
  size?: 'normal' | 'small'
  children: ReactNode
}

export function Button({ variant = 'secondary', size = 'normal', className = '', children, ...props }: ButtonProps) {
  return <button className={`button button--${variant} button--${size} ${className}`} {...props}>{children}</button>
}

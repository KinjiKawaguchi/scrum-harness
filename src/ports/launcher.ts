import type { MemberSpec, Product } from '../members/config.ts'

/** What a product needs to start a member: the settings with the defaults applied, and the first message. */
export type LaunchRequest = {
  readonly name: string
  readonly spec: MemberSpec
  /** The first message: the member's brief, or the note a moved member gets */
  readonly brief: string
  /** The id of the session to continue (a member that is moved to another account keeps its conversation) */
  readonly resume?: string
}

/** Builds the command line that starts a member of one product. Pure; it runs nothing. */
export type ProductLauncher = (request: LaunchRequest, scrum?: string) => readonly string[]

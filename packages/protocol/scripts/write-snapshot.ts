import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { contractSnapshot } from '@poietica/contract-kit'
import { appContract } from '../src/index'

const file = path.join(import.meta.dir, '..', 'src', '__tests__', 'contract.snapshot.json')
writeFileSync(file, contractSnapshot(appContract))

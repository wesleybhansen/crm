import fs from 'node:fs'
import path from 'node:path'

describe('GTM production runtime dependencies', () => {
  it('declares mailbox and SMTP packages in the app workspace', () => {
    const packagePath = path.resolve(__dirname, '../../../../../package.json')
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(packageJson.dependencies).toMatchObject({
      imapflow: expect.any(String),
      mailparser: expect.any(String),
      nodemailer: expect.any(String),
    })
  })
})

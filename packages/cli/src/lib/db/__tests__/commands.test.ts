import path from 'node:path'
import {
  sanitizeModuleId,
  validateTableName,
  makeConstraintDropsIdempotent,
  orderModulesForMigration,
  resolveGeneratedMigrationPath,
  normalizeMigrationReconciliations,
  dbGreenfield,
} from '../commands'

describe('db commands security', () => {
  describe('sanitizeModuleId', () => {
    it('should preserve valid module IDs', () => {
      expect(sanitizeModuleId('customers')).toBe('customers')
      expect(sanitizeModuleId('auth')).toBe('auth')
      expect(sanitizeModuleId('api_keys')).toBe('api_keys')
      expect(sanitizeModuleId('catalog123')).toBe('catalog123')
    })

    it('should replace hyphens with underscores', () => {
      expect(sanitizeModuleId('my-module')).toBe('my_module')
      expect(sanitizeModuleId('test-module-name')).toBe('test_module_name')
    })

    it('should replace special characters with underscores', () => {
      expect(sanitizeModuleId('module.name')).toBe('module_name')
      expect(sanitizeModuleId('module@name')).toBe('module_name')
      expect(sanitizeModuleId('module/name')).toBe('module_name')
    })

    it('should sanitize SQL injection attempts', () => {
      expect(sanitizeModuleId('module; DROP TABLE users;--')).toBe('module__DROP_TABLE_users___')
      expect(sanitizeModuleId("test' OR '1'='1")).toBe('test__OR__1___1')
      expect(sanitizeModuleId('test" OR "1"="1')).toBe('test__OR__1___1')
    })

    it('should handle newlines and special whitespace', () => {
      expect(sanitizeModuleId('module\ntest')).toBe('module_test')
      expect(sanitizeModuleId('module\rtest')).toBe('module_test')
      expect(sanitizeModuleId('module\ttest')).toBe('module_test')
    })

    it('should preserve uppercase letters', () => {
      expect(sanitizeModuleId('MyModule')).toBe('MyModule')
      expect(sanitizeModuleId('API_Keys')).toBe('API_Keys')
    })

    it('should handle empty string', () => {
      expect(sanitizeModuleId('')).toBe('')
    })
  })

  describe('validateTableName', () => {
    it('should accept valid table names', () => {
      expect(() => validateTableName('mikro_orm_migrations_customers')).not.toThrow()
      expect(() => validateTableName('mikro_orm_migrations_auth')).not.toThrow()
      expect(() => validateTableName('mikro_orm_migrations_api_keys')).not.toThrow()
      expect(() => validateTableName('_private_table')).not.toThrow()
      expect(() => validateTableName('Table123')).not.toThrow()
      expect(() => validateTableName('a')).not.toThrow()
    })

    it('should reject names starting with numbers', () => {
      expect(() => validateTableName('123_table')).toThrow(/Invalid table name/)
      expect(() => validateTableName('1table')).toThrow(/Invalid table name/)
    })

    it('should reject names with hyphens', () => {
      expect(() => validateTableName('table-name')).toThrow(/Invalid table name/)
    })

    it('should reject names with spaces', () => {
      expect(() => validateTableName('table name')).toThrow(/Invalid table name/)
    })

    it('should reject names with dots', () => {
      expect(() => validateTableName('schema.table')).toThrow(/Invalid table name/)
    })

    it('should reject names with semicolons', () => {
      expect(() => validateTableName('table;drop')).toThrow(/Invalid table name/)
    })

    it('should reject empty string', () => {
      expect(() => validateTableName('')).toThrow(/Invalid table name/)
    })

    it('should include the invalid table name in error message', () => {
      expect(() => validateTableName('invalid-name')).toThrow(/invalid-name/)
    })
  })
})

describe('makeConstraintDropsIdempotent', () => {
  it('adds IF EXISTS to standard drop constraint statements', () => {
    const sql = 'alter table "users" drop constraint "fk_user_org";'

    const result = makeConstraintDropsIdempotent(sql)

    expect(result).toBe('alter table "users" drop constraint if exists "fk_user_org";')
  })

  it('keeps already idempotent statements unchanged', () => {
    const sql = 'alter table "users" drop constraint if exists "fk_user_org";'

    const result = makeConstraintDropsIdempotent(sql)

    expect(result).toBe(sql)
  })

  it('handles multiple statements and multiline SQL', () => {
    const sql = [
      'alter table "users" drop constraint "fk_user_org";',
      'alter table orders drop constraint fk_order_user;',
      'alter table public_logs',
      '  drop constraint   "ck_log_created";',
    ].join('\n')

    const result = makeConstraintDropsIdempotent(sql)

    expect(result).toBe([
      'alter table "users" drop constraint if exists "fk_user_org";',
      'alter table orders drop constraint if exists fk_order_user;',
      'alter table public_logs drop constraint if exists "ck_log_created";',
    ].join('\n'))
  })

  it('does not alter DROP CONSTRAINT with CASCADE suffix', () => {
    const sql = 'alter table "users" drop constraint "fk_user_org" cascade;'

    const result = makeConstraintDropsIdempotent(sql)

    expect(result).toBe(sql)
  })
})

describe('orderModulesForMigration', () => {
  it('preserves the application-declared dependency order', () => {
    const modules = [
      { id: 'directory' },
      { id: 'auth' },
      { id: 'customers' },
      { id: 'email', from: '@app' },
    ]

    expect(orderModulesForMigration(modules)).toEqual(modules)
  })

  it('does not mutate the application module registry', () => {
    const modules = [{ id: 'directory' }, { id: 'auth' }]

    expect(orderModulesForMigration(modules)).not.toBe(modules)
  })
})

describe('resolveGeneratedMigrationPath', () => {
  const migrationRoot = path.join('/tmp', 'open-mercato', 'auth', 'migrations')

  it('resolves a generator basename beneath the module migration directory', () => {
    expect(resolveGeneratedMigrationPath(migrationRoot, 'Migration20260803000000.ts')).toBe(
      path.join(migrationRoot, 'Migration20260803000000.ts')
    )
  })

  it('preserves an absolute generated path inside the module migration directory', () => {
    const generatedPath = path.join(migrationRoot, 'Migration20260803000000.ts')

    expect(resolveGeneratedMigrationPath(migrationRoot, generatedPath)).toBe(generatedPath)
  })

  it('refuses a generated path outside the module migration directory', () => {
    expect(() => resolveGeneratedMigrationPath(migrationRoot, '../Migration20260803000000.ts')).toThrow(
      'Generated migration path escaped its module migration directory'
    )
  })
})

describe('normalizeMigrationReconciliations', () => {
  it('accepts exact finite reconciliation records in declared order', () => {
    const reconciliations = [
      { id: 'auth_gdpr_triggers', sql: 'select 1' },
      { id: 'search_gdpr_triggers', sql: 'select 2' },
    ]

    expect(normalizeMigrationReconciliations(reconciliations)).toEqual(reconciliations)
  })

  it.each([
    null,
    {},
    [{ id: 'auth_gdpr_triggers' }],
    [{ id: 'auth_gdpr_triggers', sql: '' }],
    [{ id: 'Auth-Gdpr', sql: 'select 1' }],
    [{ id: 'auth_gdpr_triggers', sql: 'select 1', extra: true }],
  ])('refuses malformed reconciliation input', (value) => {
    expect(() => normalizeMigrationReconciliations(value)).toThrow()
  })
})

describe('db commands', () => {
  describe('dbGreenfield', () => {
    it('should require --yes flag', async () => {
      // Mock console.error and process.exit
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation()
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called')
      })

      const mockResolver = {
        loadEnabledModules: () => [],
        getOutputDir: () => '/tmp/test',
        getRootDir: () => '/tmp',
        getModulePaths: () => ({ appBase: '', pkgBase: '' }),
      } as any

      await expect(dbGreenfield(mockResolver, { yes: false })).rejects.toThrow('process.exit called')

      expect(mockConsoleError).toHaveBeenCalledWith(
        'This command will DELETE all data. Use --yes to confirm.'
      )

      mockConsoleError.mockRestore()
      mockExit.mockRestore()
    })
  })

  describe('integration with sanitization', () => {
    it('should create safe table names from any module ID', () => {
      const dangerousIds = [
        'module; DROP TABLE users;--',
        "test' OR '1'='1",
        'module\ninjection',
        '../../../etc/passwd',
      ]

      dangerousIds.forEach(id => {
        const sanitized = sanitizeModuleId(id)
        const tableName = `mikro_orm_migrations_${sanitized}`

        // The resulting table name should be valid
        expect(() => validateTableName(tableName)).not.toThrow()
      })
    })
  })
})

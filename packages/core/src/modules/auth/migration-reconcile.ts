export const migrationReconciliations = [
  {
    id: 'auth_gdpr_triggers',
    sql: `
      do $$
      declare table_row record;
      declare trigger_arguments text;
      begin
        if to_regprocedure('public.crm_gdpr_guard_user_insert()') is not null
           and to_regclass('public.users') is not null then
          drop trigger if exists crm_gdpr_guard_user_insert on public.users;
          create trigger crm_gdpr_guard_user_insert
            before insert or update on public.users
            for each row execute function public.crm_gdpr_guard_user_insert();
        end if;

        if to_regprocedure('public.crm_gdpr_guard_organization_write()') is not null
           and to_regclass('public.organizations') is not null then
          drop trigger if exists crm_gdpr_guard_organization_write on public.organizations;
          create trigger crm_gdpr_guard_organization_write
            before insert or update or delete on public.organizations
            for each row execute function public.crm_gdpr_guard_organization_write();
        end if;

        if to_regprocedure('public.crm_gdpr_guard_org_scoped_write()') is not null then
          for table_row in
            select distinct columns.table_name
              from information_schema.columns as columns
              join information_schema.tables as tables
                on tables.table_schema = columns.table_schema
               and tables.table_name = columns.table_name
             where columns.table_schema = 'public'
               and columns.column_name = 'organization_id'
               and tables.table_type = 'BASE TABLE'
               and columns.table_name not in (
                 'organizations',
                 'gdpr_user_subjects',
                 'gdpr_local_write_leases',
                 'gdpr_org_subjects'
               )
             order by columns.table_name
          loop
            execute format(
              'drop trigger if exists crm_gdpr_guard_org_scoped_write on public.%I',
              table_row.table_name
            );
            execute format(
              'create trigger crm_gdpr_guard_org_scoped_write before insert or update or delete on public.%I for each row execute function public.crm_gdpr_guard_org_scoped_write()',
              table_row.table_name
            );
          end loop;
        end if;

        if to_regprocedure('public.crm_gdpr_guard_user_scoped_write()') is not null then
          for table_row in
            select columns.table_name,
                   array_agg(columns.column_name order by columns.column_name) as user_columns
              from information_schema.columns as columns
              join information_schema.tables as tables
                on tables.table_schema = columns.table_schema
               and tables.table_name = columns.table_name
             where columns.table_schema = 'public'
               and tables.table_type = 'BASE TABLE'
               and (
                 lower(columns.column_name) = 'user_id'
                 or lower(columns.column_name) like '%\\_user\\_id' escape '\\'
                 or lower(columns.column_name) in (
                   'assigned_to', 'claimed_by', 'completed_by', 'created_by',
                   'updated_by', 'uploaded_by'
                 )
                 or exists (
                   select 1
                     from pg_catalog.pg_constraint as foreign_keys
                     join pg_catalog.pg_class as child_tables
                       on child_tables.oid = foreign_keys.conrelid
                     join pg_catalog.pg_namespace as child_namespaces
                       on child_namespaces.oid = child_tables.relnamespace
                     join pg_catalog.pg_attribute as child_columns
                       on child_columns.attrelid = foreign_keys.conrelid
                      and child_columns.attnum = any(foreign_keys.conkey)
                     join pg_catalog.pg_class as parent_tables
                       on parent_tables.oid = foreign_keys.confrelid
                     join pg_catalog.pg_namespace as parent_namespaces
                       on parent_namespaces.oid = parent_tables.relnamespace
                     join pg_catalog.pg_attribute as parent_columns
                       on parent_columns.attrelid = foreign_keys.confrelid
                      and parent_columns.attnum = any(foreign_keys.confkey)
                    where foreign_keys.contype = 'f'
                      and child_namespaces.nspname = columns.table_schema
                      and child_tables.relname = columns.table_name
                      and child_columns.attname = columns.column_name
                      and parent_namespaces.nspname = 'public'
                      and parent_tables.relname = 'users'
                      and parent_columns.attname = 'id'
                 )
               )
               and columns.table_name not in (
                 'users', 'gdpr_identity_fences', 'gdpr_user_subjects', 'gdpr_user_receipts',
                 'gdpr_user_search_subjects', 'gdpr_user_write_leases'
               )
             group by columns.table_name
             order by columns.table_name
          loop
            select string_agg(quote_literal(column_name), ', ' order by column_name)
              into trigger_arguments
              from unnest(table_row.user_columns) as column_name;
            execute format(
              'drop trigger if exists crm_gdpr_guard_user_scoped_write on public.%I',
              table_row.table_name
            );
            execute format(
              'create trigger crm_gdpr_guard_user_scoped_write before insert or update or delete on public.%I for each row execute function public.crm_gdpr_guard_user_scoped_write(%s)',
              table_row.table_name,
              trigger_arguments
            );
          end loop;
        end if;

        if to_regprocedure('public.crm_gdpr_lock_user_search_subject()') is not null
           and to_regclass('public.gdpr_user_search_subjects') is not null then
          drop trigger if exists crm_gdpr_lock_user_search_subject
            on public.gdpr_user_search_subjects;
          create trigger crm_gdpr_lock_user_search_subject
            before insert or update on public.gdpr_user_search_subjects
            for each row execute function public.crm_gdpr_lock_user_search_subject();
        end if;

        if to_regprocedure('public.crm_gdpr_guard_user_search_write()') is not null then
          for table_row in
            select * from (values
              ('entity_indexes', 'entity_id'),
              ('search_tokens', 'entity_id'),
              ('vector_search', 'record_id'),
              ('indexer_error_logs', 'record_id'),
              ('indexer_status_logs', 'record_id')
            ) as expected(table_name, record_column)
           where exists (
             select 1
               from information_schema.columns
              where table_schema = 'public'
                and table_name = expected.table_name
                and column_name = expected.record_column
           )
             and exists (
               select 1
                 from information_schema.columns
                where table_schema = 'public'
                  and table_name = expected.table_name
                  and column_name = 'tenant_id'
             )
           order by expected.table_name
          loop
            execute format(
              'drop trigger if exists crm_gdpr_guard_user_search_write on public.%I',
              table_row.table_name
            );
            execute format(
              'create trigger crm_gdpr_guard_user_search_write before insert or update on public.%I for each row execute function public.crm_gdpr_guard_user_search_write(%L)',
              table_row.table_name,
              table_row.record_column
            );
          end loop;
        end if;
      end;
      $$;
    `,
  },
]

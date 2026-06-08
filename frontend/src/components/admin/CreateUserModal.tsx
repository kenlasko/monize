'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { adminApi, CreateUserResponse } from '@/lib/admin';
import { passwordSchema, emailSchema } from '@/lib/zod-helpers';
import { getErrorMessage } from '@/lib/errors';

type CredentialMethod = 'invite' | 'password' | 'temporary';

// The password field is only validated when the "password" credential method
// is chosen; for invite/temporary it is left blank. A superRefine keeps the
// shared passwordSchema rules without forcing a password for the other methods.
const createUserSchema = z
  .object({
    email: emailSchema,
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    role: z.enum(['user', 'admin']),
    method: z.enum(['invite', 'password', 'temporary']),
    password: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.method === 'password') {
      const result = passwordSchema.safeParse(data.password ?? '');
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['password'],
          message: result.error.issues[0]?.message ?? 'Invalid password.',
        });
      }
    }
  });

type CreateUserFormData = z.infer<typeof createUserSchema>;

interface CreateUserModalProps {
  isOpen: boolean;
  smtpConfigured: boolean;
  onClose: () => void;
  onCreated: (result: CreateUserResponse) => void;
}

export function CreateUserModal({
  isOpen,
  smtpConfigured,
  onClose,
  onCreated,
}: CreateUserModalProps) {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const defaultMethod: CredentialMethod = smtpConfigured ? 'invite' : 'password';

  const {
    control,
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserFormData>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      email: '',
      firstName: '',
      lastName: '',
      role: 'user',
      method: defaultMethod,
      password: '',
    },
  });

  const method = useWatch({ control, name: 'method' });

  // Reset the form to its initial state whenever the modal transitions open.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      reset({
        email: '',
        firstName: '',
        lastName: '',
        role: 'user',
        method: defaultMethod,
        password: '',
      });
    }
  }

  const onSubmit = async (data: CreateUserFormData) => {
    try {
      const result = await adminApi.createUser({
        email: data.email.trim(),
        firstName: data.firstName?.trim() || undefined,
        lastName: data.lastName?.trim() || undefined,
        role: data.role,
        password: data.method === 'password' ? data.password : undefined,
        sendInvite: data.method === 'invite',
      });
      onCreated(result);
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, t('createUserModal.toasts.createFailed')));
    }
  };

  const inputClass =
    'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100';

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg" pushHistory>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {t('createUserModal.title')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('createUserModal.description')}
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          <Input
            type="email"
            label={t('createUserModal.emailLabel')}
            required
            placeholder={t('createUserModal.emailPlaceholder')}
            error={errors.email?.message}
            {...register('email')}
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('createUserModal.firstNameLabel')}
              placeholder={t('createUserModal.firstNamePlaceholder')}
              {...register('firstName')}
            />
            <Input
              label={t('createUserModal.lastNameLabel')}
              placeholder={t('createUserModal.lastNamePlaceholder')}
              {...register('lastName')}
            />
          </div>

          <Select
            label={t('createUserModal.roleLabel')}
            options={[
              { value: 'user', label: t('createUserModal.roleUser') },
              { value: 'admin', label: t('createUserModal.roleAdmin') },
            ]}
            {...register('role')}
          />

          <fieldset className="space-y-2">
            <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('createUserModal.credentialsLegend')}
            </legend>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="credential-method"
                className="mt-1"
                checked={method === 'invite'}
                disabled={!smtpConfigured}
                onChange={() => setValue('method', 'invite')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('createUserModal.inviteLabel')}
                {!smtpConfigured && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {t('createUserModal.inviteSmtpNote')}
                  </span>
                )}
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="credential-method"
                className="mt-1"
                checked={method === 'password'}
                onChange={() => setValue('method', 'password')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('createUserModal.setPasswordLabel')}
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="credential-method"
                className="mt-1"
                checked={method === 'temporary'}
                onChange={() => setValue('method', 'temporary')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('createUserModal.tempPasswordLabel')}
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {t('createUserModal.tempPasswordNote')}
                </span>
              </span>
            </label>
          </fieldset>

          {method === 'password' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('createUserModal.passwordFieldLabel')}
              </label>
              <PasswordInput
                required
                placeholder={t('createUserModal.passwordPlaceholder')}
                className={inputClass}
                {...register('password')}
              />
              {errors.password?.message ? (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {errors.password.message}
                </p>
              ) : (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {tc('passwordRequirements')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {tc('cancel')}
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            {t('createUserModal.createButton')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

'use client';
import { PageHeader } from '@/components/ui';
import { VacancyForm } from '@/components/vacancy-form';

export default function NewVacancy() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Post a vacancy" back={{ href: '/app/host/vacancies', label: 'Vacancies' }} subtitle="BTBG checks the wage and hours, then publishes it and finds candidates." />
      <VacancyForm />
    </div>
  );
}

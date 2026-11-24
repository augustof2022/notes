-- Note: let Supabase Storage keep PDF documents (and Word files converted to PDF).
-- Run once in Supabase -> SQL Editor. Safe to run again.
-- Google Drive storage needs no change. The size limit follows Supabase's
-- default 50 MB per-file cap; raise both together if your plan allows larger files.
update storage.buckets
set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml','application/pdf'],
    file_size_limit = greatest(coalesce(file_size_limit, 0), 52428800)
where id = 'note-images';

package com.lettrico.app

import com.lettrico.app.data.api.ApiClient
import com.lettrico.app.data.api.ApiService
import com.lettrico.app.data.repository.AuthRepository
import com.lettrico.app.data.repository.CoverLetterRepository
import com.lettrico.app.domain.usecase.LoginUseCase
import com.lettrico.app.domain.usecase.RegisterUseCase
import com.lettrico.app.presentation.viewmodel.AuthViewModel
import com.lettrico.app.presentation.viewmodel.DashboardViewModel
import com.lettrico.app.presentation.viewmodel.ProfileViewModel
import org.koin.dsl.module

val appModule = module {
    // API
    single<ApiService> { ApiClient.createApiService() }
    
    // Repositories
    single<AuthRepository> { AuthRepository(get()) }
    single<CoverLetterRepository> { CoverLetterRepository(get()) }
    
    // Use Cases
    single { LoginUseCase(get()) }
    single { RegisterUseCase(get()) }
    
    // ViewModels
    single { AuthViewModel(get(), get()) }
    single { DashboardViewModel() }
    single { ProfileViewModel() }
}

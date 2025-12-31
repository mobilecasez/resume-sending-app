package com.lettrico.app.domain.usecase

import com.lettrico.app.data.repository.AuthRepository

class LoginUseCase(private val authRepository: AuthRepository) {
    suspend operator fun invoke(email: String, password: String) =
        authRepository.login(email, password)
}

class RegisterUseCase(private val authRepository: AuthRepository) {
    suspend operator fun invoke(fullName: String, email: String, password: String) =
        authRepository.register(fullName, email, password)
}
